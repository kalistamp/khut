/* ============================================================
   HUT CLOUD — Supabase persistence layer

   Everything here is data plumbing and auth. No DOM, no rendering —
   script.js owns the state and calls in.

   SHAPE
     tools   one row per launcher card, keyed by the app's own Date.now() id

   One table is the whole store. The delta/revision machinery in the daily,
   doc, prompts and sc schemas exists because those hold thousands of rows and
   long text; a launcher holds a couple of dozen short rows edited by one
   person, so this uses the plain upsert model from the lists schema.

   CONFLICT MODEL
     Last writer wins, per row. Two devices editing the same card at once will
     not merge; the later push overwrites. Editing one card never rewrites the
     others, because writes carry only the changed rows.
   ============================================================ */

(function () {
  'use strict';

  const PLACEHOLDER_URL = 'PUT_YOUR_SUPABASE_URL_HERE';
  const PLACEHOLDER_KEY = 'PUT_YOUR_PUBLISHABLE_KEY_HERE';
  const PLACEHOLDER_SCHEMA = 'PUT_YOUR_SCHEMA_HERE';

  // Kept in step with the CHECK constraints on hut.tools. A value no list here
  // recognises would be rejected by Postgres outright, so the row is repaired
  // on the way out rather than failing the whole batch.
  const ICON_KINDS = ['emoji', 'svg'];
  const ACCENTS = ['ember', 'citrus', 'mint', 'lagoon', 'orchid', 'slate'];
  const DEFAULT_ICON_KIND = 'emoji';
  const DEFAULT_ACCENT = 'ember';
  const DEFAULT_ICON = '\u{1F9F0}';

  // Mirrors `constraint tools_url_scheme check (url ~ '^https://')`. The app
  // renders these straight into an href, so a stored `javascript:` URL would
  // be a script-injection path. Both ends refuse it.
  const URL_PATTERN = /^https:\/\/\S+$/i;

  // Mirrors tools_name_size / tools_url_size / tools_desc_size.
  const MAX_NAME = 200;
  const MAX_URL = 2000;
  const MAX_DESCRIPTION = 1000;
  const MAX_ICON = 40;

  let sb = null;
  let signedInUserId = null;

  function configured() {
    const c = window.SUPABASE_CONFIG;
    return !!(c && c.url && c.publishableKey && c.schema &&
              c.url !== PLACEHOLDER_URL && c.publishableKey !== PLACEHOLDER_KEY &&
              c.schema !== PLACEHOLDER_SCHEMA);
  }

  function client() {
    if (sb) return sb;
    if (!configured()) return null;
    if (!window.supabase || !window.supabase.createClient) return null;
    sb = window.supabase.createClient(
      window.SUPABASE_CONFIG.url,
      window.SUPABASE_CONFIG.publishableKey,
      {
        db: { schema: window.SUPABASE_CONFIG.schema },
        auth: {
          // The session lives in localStorage and is refreshed in the
          // background, so unlocking Hut once keeps this browser signed in.
          persistSession: true,
          autoRefreshToken: true
        }
      }
    );
    return sb;
  }

  // ─────────────────────────────────────────────
  // ROW ⇄ TOOL
  // ─────────────────────────────────────────────

  // Number(null), Number('') and Number([]) are all 0, and Number.isFinite(0)
  // is true — so `Number.isFinite(Number(v))` waves nulls straight through as
  // zero. Reject non-numeric input before coercing.
  const toNum = (v) => {
    if (typeof v !== 'number' && typeof v !== 'string') return null;
    if (v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const toIdList = (arr) => (Array.isArray(arr) ? arr : [])
    .map(toNum)
    .filter(n => n !== null);

  const clamp = (v, max) => String(v == null ? '' : v).slice(0, max);

  function validUrl(value) {
    const url = String(value == null ? '' : value).trim();
    return URL_PATTERN.test(url) && url.length <= MAX_URL ? url : null;
  }

  function toolToRow(t) {
    const id = toNum(t && t.id);
    if (id === null) {
      // Every write path sets id = Date.now(); a tool without one is already
      // unusable in the UI (edit, delete and reorder all key on it). Refuse
      // rather than mint a new id, which would duplicate the card instead.
      console.warn('[cloud] skipping tool with no usable id', t);
      return null;
    }

    const url = validUrl(t.url);
    if (url === null) {
      // The CHECK constraint would reject this and fail the whole batch, so
      // drop the one bad row here and let the rest of the delta through.
      console.warn('[cloud] skipping tool whose url is not https', t);
      return null;
    }

    const sortOrder = toNum(t.sortOrder);

    return {
      id,
      name: clamp(t.name, MAX_NAME),
      url,
      icon: clamp(t.icon, MAX_ICON) || DEFAULT_ICON,
      icon_kind: ICON_KINDS.includes(t.iconKind) ? t.iconKind : DEFAULT_ICON_KIND,
      accent: ACCENTS.includes(t.accent) ? t.accent : DEFAULT_ACCENT,
      description: clamp(t.description, MAX_DESCRIPTION),
      sort_order: sortOrder === null ? 0 : sortOrder
    };
  }

  function rowToTool(r) {
    const sortOrder = toNum(r.sort_order);
    return {
      id: Number(r.id),
      name: r.name == null ? '' : String(r.name),
      url: r.url == null ? '' : String(r.url),
      icon: r.icon || DEFAULT_ICON,
      iconKind: ICON_KINDS.includes(r.icon_kind) ? r.icon_kind : DEFAULT_ICON_KIND,
      accent: ACCENTS.includes(r.accent) ? r.accent : DEFAULT_ACCENT,
      description: r.description == null ? '' : String(r.description),
      sortOrder: sortOrder === null ? 0 : sortOrder
    };
  }

  // ─────────────────────────────────────────────
  // AUTH
  // ─────────────────────────────────────────────

  async function getSession() {
    const c = client();
    if (!c) return null;
    const { data } = await c.auth.getSession();
    const session = data ? data.session : null;
    signedInUserId = session && session.user ? session.user.id : null;
    return session;
  }

  async function currentUserId(c) {
    if (signedInUserId) return signedInUserId;
    const { data, error } = await c.auth.getSession();
    if (error) throw error;
    const session = data ? data.session : null;
    signedInUserId = session && session.user ? session.user.id : null;
    if (!signedInUserId) throw new Error('not signed in');
    return signedInUserId;
  }

  async function signIn(email, password) {
    const c = client();
    if (!c) return { ok: false, error: 'Cloud sync is not configured yet (see supabase-config.js).' };
    const { data, error } = await c.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: error.message };
    signedInUserId = data.session && data.session.user ? data.session.user.id : null;
    return { ok: true, session: data.session };
  }

  async function signOut() {
    const c = client();
    if (!c) return;
    signedInUserId = null;
    await c.auth.signOut();
  }

  function onAuthChange(fn) {
    const c = client();
    if (!c) return;
    c.auth.onAuthStateChange((event, session) => {
      signedInUserId = session && session.user ? session.user.id : null;
      fn(event, session);
    });
  }

  // ─────────────────────────────────────────────
  // READ
  // ─────────────────────────────────────────────

  async function pull() {
    const c = client();
    if (!c) throw new Error('not configured');

    // Explicit order: PostgREST gives no ordering guarantee without one.
    // sort_order is the drag-reorder position; id breaks ties, so two cards
    // sharing a position stay in a stable order across devices.
    const { data, error } = await c.from('tools')
      .select('id, name, url, icon, icon_kind, accent, description, sort_order')
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });

    if (error) throw error;
    return { tools: (data || []).map(rowToTool) };
  }

  // ─────────────────────────────────────────────
  // WRITE
  // ─────────────────────────────────────────────

  // `list` contains only changed/new tools. Deletions are an explicit,
  // separately guarded delta, so editing one card never rewrites every row.
  async function pushTools(list) {
    const c = client();
    if (!c) throw new Error('not configured');

    const userId = await currentUserId(c);
    const rows = (list || []).map(toolToRow).filter(Boolean)
      .map(row => ({ ...row, user_id: userId }));
    if (!rows.length) return;

    const { error } = await c.from('tools').upsert(rows, {
      onConflict: 'user_id,id'
    });
    if (error) throw error;
  }

  // GUARD: PostgREST turns a DELETE with no filter into "delete every row".
  // Refuse an empty/invalid delta before issuing the request.
  async function deleteTools(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const clean = toIdList(ids);
    if (clean.length === 0) {
      console.warn('[cloud] refusing tool delete: no valid ids after filtering');
      return;
    }
    const c = client();
    if (!c) throw new Error('not configured');
    const { error } = await c.from('tools').delete().in('id', clean);
    if (error) throw error;
  }

  window.HutCloud = {
    configured,
    getSession,
    signIn,
    signOut,
    onAuthChange,
    pull,
    pushTools,
    deleteTools,
    // Exposed for script.js validation and for the tests; the UI must reject
    // a non-https URL at the form, not discover it at the database.
    validUrl,
    ACCENTS,
    ICON_KINDS,
    LIMITS: { MAX_NAME, MAX_URL, MAX_DESCRIPTION, MAX_ICON }
  };
})();
