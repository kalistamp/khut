import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../supabase.js', import.meta.url), 'utf8');

function harness() {
  const calls = [];
  const data = {
    tools: [
      {
        id: 2, name: 'Docket', url: 'https://kalistamp.github.io/doc/',
        icon: '\u{1F5C2}️', icon_kind: 'emoji', accent: 'lagoon',
        description: 'Notes and files', sort_order: 20
      },
      {
        id: 1, name: 'Daily', url: 'https://kalistamp.github.io/daily/',
        icon: 'bolt', icon_kind: 'svg', accent: 'nonsense',
        description: '', sort_order: 10
      }
    ]
  };

  class Query {
    constructor(table) { this.table = table; this.result = { data: null, error: null }; }
    select() { this.result.data = data[this.table]; return this; }
    order() { return this; }
    eq() { return this; }
    maybeSingle() { return this; }
    upsert(rows, options) {
      calls.push({ operation: 'upsert', table: this.table, rows, options });
      return this;
    }
    delete() { this.operation = 'delete'; return this; }
    in(column, values) {
      calls.push({ operation: this.operation, table: this.table, column, values });
      return this;
    }
    then(resolve, reject) { return Promise.resolve(this.result).then(resolve, reject); }
  }

  const client = {
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: 'user-1', email: 'me@example.com' } } },
        error: null
      }),
      signInWithPassword: async () => ({
        data: { session: { user: { id: 'user-1' } } }, error: null
      }),
      signOut: async () => {},
      onAuthStateChange: () => {}
    },
    from: table => new Query(table)
  };

  let createArgs;
  const warnings = [];
  const window = {
    SUPABASE_CONFIG: {
      url: 'https://example.supabase.co', publishableKey: 'public-key', schema: 'hut'
    },
    supabase: {
      createClient: (...args) => { createArgs = args; return client; }
    }
  };
  const fakeConsole = { warn: (...args) => warnings.push(args), log() {}, error() {} };
  vm.runInNewContext(source, { window, console: fakeConsole, Date, Set });
  return { cloud: window.HutCloud, calls, warnings, createArgs: () => createArgs };
}

test('client routes database calls to the hut schema', async () => {
  const h = harness();
  await h.cloud.getSession();
  assert.equal(h.createArgs()[2].db.schema, 'hut');
});

test('an unconfigured placeholder build never builds a client', () => {
  const h = harness();
  assert.equal(h.cloud.configured(), true);
  // The deployed copy has the placeholders substituted; the repo copy does not.
  const source_has_placeholder = /PUT_YOUR_PUBLISHABLE_KEY_HERE/.test(source);
  assert.equal(source_has_placeholder, true);
});

test('writes attach the signed-in user and use composite conflicts', async () => {
  const h = harness();
  await h.cloud.getSession();
  await h.cloud.pushTools([
    { id: 3, name: 'Lists', url: 'https://kalistamp.github.io/lists/', sortOrder: 30 }
  ]);

  const writes = h.calls.filter(call => call.operation === 'upsert');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].rows[0].user_id, 'user-1');
  assert.equal(writes[0].options.onConflict, 'user_id,id');
});

test('pull maps database rows into app tools', async () => {
  const h = harness();
  const document = await h.cloud.pull();
  assert.equal(document.tools.length, 2);

  const docket = document.tools.find(tool => tool.id === 2);
  assert.equal(docket.name, 'Docket');
  assert.equal(docket.url, 'https://kalistamp.github.io/doc/');
  assert.equal(docket.iconKind, 'emoji');
  assert.equal(docket.accent, 'lagoon');
  assert.equal(docket.sortOrder, 20);

  // An accent the CHECK constraint does not allow folds to the default rather
  // than reaching the stylesheet as an unknown class.
  const daily = document.tools.find(tool => tool.id === 1);
  assert.equal(daily.accent, 'ember');
  assert.equal(daily.iconKind, 'svg');
});

test('tool writes upsert only the supplied row delta', async () => {
  const h = harness();
  await h.cloud.getSession();
  await h.cloud.pull();
  await h.cloud.pushTools([
    { id: 1, name: 'Daily', url: 'https://kalistamp.github.io/daily/' }
  ]);

  const upserts = h.calls.filter(call => call.operation === 'upsert' && call.table === 'tools');
  const deletes = h.calls.filter(call => call.operation === 'delete');
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].rows.length, 1);
  assert.equal(upserts[0].rows[0].id, 1);
  assert.equal(deletes.length, 0);
});

test('a tool whose url is not https is dropped, not sent to the CHECK constraint', async () => {
  const h = harness();
  await h.cloud.getSession();
  await h.cloud.pushTools([
    { id: 4, name: 'Bad', url: 'javascript:alert(1)' },
    { id: 5, name: 'Insecure', url: 'http://example.com/' },
    { id: 6, name: 'Good', url: 'https://example.com/' }
  ]);

  const upserts = h.calls.filter(call => call.operation === 'upsert');
  assert.equal(upserts.length, 1);
  assert.deepEqual(upserts[0].rows.map(row => row.id), [6]);
  assert.equal(h.warnings.length, 2);
});

test('validUrl agrees with the database CHECK constraint', () => {
  const h = harness();
  assert.equal(h.cloud.validUrl('https://example.com/'), 'https://example.com/');
  assert.equal(h.cloud.validUrl('  https://example.com/  '), 'https://example.com/');
  assert.equal(h.cloud.validUrl('http://example.com/'), null);
  assert.equal(h.cloud.validUrl('javascript:alert(1)'), null);
  assert.equal(h.cloud.validUrl('data:text/html,x'), null);
  assert.equal(h.cloud.validUrl(''), null);
  assert.equal(h.cloud.validUrl(null), null);
});

test('a tool with no usable id is refused rather than given a new one', async () => {
  const h = harness();
  await h.cloud.getSession();
  await h.cloud.pushTools([{ name: 'No id', url: 'https://example.com/' }]);
  assert.equal(h.calls.filter(call => call.operation === 'upsert').length, 0);
});

test('oversized text is clamped to the size the constraints allow', async () => {
  const h = harness();
  await h.cloud.getSession();
  await h.cloud.pushTools([{
    id: 7,
    name: 'n'.repeat(500),
    description: 'd'.repeat(5000),
    url: 'https://example.com/'
  }]);

  const row = h.calls.find(call => call.operation === 'upsert').rows[0];
  assert.equal(row.name.length, 200);
  assert.equal(row.description.length, 1000);
});

test('explicit deletes are filtered and an empty delta cannot issue a delete', async () => {
  const h = harness();
  await h.cloud.getSession();
  await h.cloud.deleteTools([]);
  await h.cloud.deleteTools([null, '', undefined]);
  await h.cloud.deleteTools([2, null, '']);

  const deletes = h.calls.filter(call => call.operation === 'delete');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].table, 'tools');
  assert.equal(deletes[0].column, 'id');
  assert.deepEqual(deletes[0].values, [2]);
});
