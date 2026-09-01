# Kalistamp Hut

The launcher. One wall of cards, one per tool, served straight from GitHub
Pages. No build step, no bundler — `index.html` loads the scripts directly.

| File | What it does |
|---|---|
| `index.html` | Markup, CSP, the built-in glyph sprite, script loading |
| `style.css` | Everything visual, dark and light |
| `script.js` | In-memory state, rendering, and the UI (`window.HutApp`) |
| `supabase.js` | Persistence: auth plus the one table (`window.HutCloud`) |
| `supabase-config.js` | Shared-project URL, publishable key, and `hut` schema |
| `tests/cloud.test.mjs` | Tests for the persistence layer |
| `.github/workflows/deploy-pages.yml` | Tests, injects public config, and deploys Pages |

## Storage

Data lives in the shared Supabase project's `hut` Postgres schema:

| Table | Shape |
|---|---|
| `hut.tools` | One row per card, keyed by user plus the app's `Date.now()` id |

One table is the whole store. The delta/revision machinery in the `daily`,
`doc`, `prompts` and `sc` schemas exists because those hold thousands of rows
and long text; a launcher holds a couple of dozen short rows edited by one
person, so this uses the plain upsert model from the `lists` schema.

`localStorage` is still written on every change, but it is the first-paint
cache and the signed-out view — not the record. Signing in pulls from the
database over the top of it.

### Hut never requires a sign-in

It is a home base. You sign in to the tools it launches, if those tools ask for
it — not to the launcher. Adding, editing, deleting and reordering all work
signed out, with no account and no network, and persist in `localStorage`.

That is why the six starter tools are a `DEFAULT_TOOLS` constant in `script.js`
rather than rows inserted by a migration: the page has to work before there is
an account, a database, or a connection. Their ids come from a fixed base
rather than `Date.now()`, so two devices seeding independently produce the same
six ids instead of twelve cards.

Signing in is opt-in cloud sync and nothing else — it carries the same wall to
your other devices.

### What signing in merges

Because the wall is fully editable signed out, a device may already hold cards
that exist nowhere else by the time an account is attached. Signing in
therefore **merges** rather than overwrites:

| Case | Winner |
|---|---|
| Card only this device has | kept, and pushed up |
| Card edited here, not yet pushed | this device |
| Card deleted here, not yet pushed | stays deleted, and the delete is pushed |
| Anything else | the cloud row |

All four are consistent with the per-row last-writer-wins model below. A plain
overwrite would have silently thrown away offline work, which is the one
outcome a launcher must not produce.

### Conflict model

Last writer wins, per row. Two devices editing the same card at once will not
merge. Editing one card never rewrites the others: writes carry only the
changed rows, and deletions are a separate, explicitly guarded delta.

## Fresh setup in the shared Supabase project

Database migrations, configuration, and cleanup SQL live outside this static
repository under
`/home/ks/Documents/projects_audit/prelaunch_deployment/shared_supabase`.

1. **Create the schema.** From the external operations directory, link the
   production project and apply `20260831210000_hut_schema.sql`:

   ```bash
   cd /home/ks/Documents/projects_audit/prelaunch_deployment/shared_supabase
   npx --yes supabase@latest migration list
   npx --yes supabase@latest db push --dry-run
   npx --yes supabase@latest db push
   ```

   The migration is additive. It creates the `hut` schema and one table and
   touches nothing that belongs to another application.

2. **Expose the schema.** Open the project's Data API settings, find **Exposed
   schemas**, add `hut` **without removing existing schemas**, and save. The
   local `config.toml` already lists it, so `config push` does the same job if
   you would rather push than click.

3. **Auth needs no change.** Hut is another schema in the same project, signed
   into with the same account as Docket, Lists, Daily and Prompts. Signup stays
   disabled; there is intentionally no sign-up flow.

4. **Configure GitHub Actions.** In GitHub, open Settings → Secrets and
   variables → Actions → Repository secrets and add:

   - `SUPABASE_URL`: the shared project's URL.
   - `SUPABASE_PUBLISHABLE_KEY`: the shared project's `sb_publishable_...` key.

   Never substitute the service-role key. The workflow does not read it, and
   fails the build if anything resembling one reaches the artifact.

5. **Configure Pages.** Open Settings → Pages and choose **GitHub Actions** as
   the source. The deployment workflow injects the two public values into the
   deployed copy of `supabase-config.js`; the repository itself retains
   placeholders.

6. **Test production.** Open the Pages site, sign in, confirm the six starter
   cards seed, add a card, reload, and confirm it persists.

To remove this application from the shared project later, first export its
data, then run `supabase/cleanup/remove_hut_schema.sql` from the external
operations directory and remove `hut` from Exposed schemas.

## Security

The publishable key in `supabase-config.js` is meant to be public. It ships in
the page source of a public site and that is fine, because it grants nothing on
its own:

- `hut.tools` has RLS enabled *and* forced.
- The table has `user_id`, and the policy requires `auth.uid() = user_id`.
- `anon` has **zero** policies and is revoked from the `hut` schema itself, not
  merely from the table — so an unauthenticated caller cannot even resolve it.

So the key can be used to *attempt* a sign-in and nothing else. The protection
is row-level security, not the secrecy of the key.

The `service_role` key is a different thing entirely — it bypasses RLS. It must
never appear in this repo, the Pages artifact, or anywhere in the browser.

Two further guards, because a card's URL is rendered straight into an `href`:

- `constraint tools_url_scheme check (url ~ '^https://')` in the database.
- `validUrl()` in `supabase.js`, which the editor form calls before saving.

Neither end trusts the other to have checked. A stored `javascript:` URL would
otherwise be a script-injection path into the page, and the page's CSP has no
`unsafe-inline` to fall back on.

## Design notes

The card motion — the tilt, the cursor-tracked glow, the icon pop — is bound
behind `(hover: hover) and (pointer: fine)`, so a phone never parses a tilt it
has no pointer to drive and gets a press-scale instead. Everything animates on
`transform` and `opacity` only, and `prefers-reduced-motion: reduce` collapses
the whole motion layer to colour and opacity.

The stylesheet deliberately avoids `oklch`, `color-mix`, `backdrop-filter` and
container queries, for the same reason the `dough` app does: these pages get
opened on older phones, where a half-supported colour function degrades to
something unreadable rather than something plain.

Reordering is Pointer Events, not HTML5 drag-and-drop, because HTML5 DnD does
not fire on touch at all. `Alt` + `←`/`→` on a focused card does the same job
from the keyboard.

## Tests

```
node --test tests/cloud.test.mjs
```

Zero dependencies, no network. It evaluates `supabase.js` against a fake window
and a stub client that records queries instead of sending them. It covers the
tool ⇄ row mapping, the composite-conflict upsert, the guarded explicit-delete
path, the size clamps, and the https-only URL rule agreeing with the database
CHECK constraint.

## Local preview

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/>. With the placeholders unsubstituted the
page runs in local-only mode: the six cards render and launch, and the sync
pill reads "Local only".
