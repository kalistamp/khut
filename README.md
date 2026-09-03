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

It also holds what is deliberately *not* a record: `hut.usage` (launch counts),
`hut.view`, `hut.order` and `hut.theme`. Those are per-device preferences, so
they never reach the database.

### Everything is behind the sign-in

A sign-in gate is the first and only screen until Supabase returns a user. The
wall is not rendered and no row is fetched before that: `openApp()` owns the
first paint, and nothing above it touches `state.tools`. This matches the gate
contract already used by Docket, SC and Daily — full-screen overlay, an
`unlocked` guard, session restored silently on load, a shake on refusal, and a
reload on sign-out.

This replaces the earlier model, where the wall was public and only the edit
controls sat behind the account. That was a defensible design for a launcher —
each tool asks for its own login anyway — but it is not what this app does now:
**viewing the wall requires an account.**

Be precise about what the gate does and does not do. It is a **UI boundary, not
the security boundary.** An anonymous visitor could never reach your data
regardless: `hut.tools` has RLS enabled *and* forced, the policy tests
`auth.uid() = user_id`, and `anon` is revoked from the `hut` schema itself, so
an unauthenticated caller cannot even resolve the table name. The gate keeps
the wall private; **row-level security is what keeps the data safe.**

### What signing in merges

A device can be carrying edits made while signed in and offline, or before a
session expired, still unpushed. Signing in therefore **merges** rather than
overwrites:

| Case | Winner |
|---|---|
| Card only this device has | kept, and pushed up |
| Card edited here, not yet pushed | this device |
| Card deleted here, not yet pushed | stays deleted, and the delete is pushed |
| Anything else | the cloud row |

All four are consistent with the per-row last-writer-wins model below. A plain
overwrite would silently throw away offline work, which is the one outcome a
launcher must not produce.

### Conflict model

Last writer wins, per row. Two devices editing the same card at once will not
merge. Editing one card never rewrites the others: writes carry only the
changed rows, and deletions are a separate, explicitly guarded delta.

## Fresh setup in the shared Supabase project

Database migrations, configuration, and cleanup SQL live outside this static
repository under
`/home/ks/Documents/projects_audit/prelaunch_deployment/shared_supabase`.

1. **Create the schema.** Either paste
   `supabase/sql_editor/hut_schema.sql` from the external operations directory
   into the Supabase SQL editor and run it — it carries verification queries
   and is safe to run more than once — or apply the identical CLI migration:

   ```bash
   cd /home/ks/Documents/projects_audit/prelaunch_deployment/shared_supabase
   npx --yes supabase@latest migration list
   npx --yes supabase@latest db push --dry-run
   npx --yes supabase@latest db push
   ```

   Both are additive and carry the same DDL: they create the `hut` schema and
   one table, and touch nothing belonging to another application.

2. **Expose the schema.** Open the project's Data API settings, find **Exposed
   schemas**, add `hut` **without removing existing schemas**, and save. The
   local `config.toml` already lists it, so `config push` does the same job if
   you would rather push than click.

3. **Create the login.** Signup is disabled project-wide on purpose, so open
   Authentication → Users → Add user → Create new user and tick **Auto Confirm
   User**. Hut is another schema in the same project, so the account you
   already use signs in here too — there is intentionally no sign-up flow.
   This is what unlocks add, edit, delete and reorder.

4. **Configure GitHub Actions.** Open Settings → Secrets and variables →
   Actions → Repository secrets and add both:

   - `SUPABASE_URL`: the shared project's URL.
   - `SUPABASE_PUBLISHABLE_KEY`: the shared project's `sb_publishable_...` key.

   These are what connect the deployed site to the database. Without them the
   site still deploys and still launches every tool, but the wall is read-only:
   there is no account to sign in to, so nothing can be added or changed.

   Set both or neither — the workflow fails the build on a partial pair, since
   that can only be a mistake. Never substitute the service-role key; the
   workflow does not read it, and fails the build if anything resembling one
   reaches the artifact.

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

## Finding a tool

The wall is an index, not a display case. There are three ways in, and the
keyboard is the fast one:

| | |
|---|---|
| `Ctrl`/`⌘` + `K`, or `/` | Open the command palette |
| type, then `↵` | Launch the first match |
| `↑` `↓` | Move through results |
| arrow keys on a focused card | Walk the wall |
| `Alt` + `←`/`→` on a focused card | Reorder it (manual order only) |

The palette searches names, descriptions and hosts, and ranks a prefix on the
name above a hit buried in a description — a launcher is judged on whether the
thing you meant is the first row after two keystrokes. It also carries the
actions (add, theme, view, order, sign in/out), so the toolbar never has to
grow a button for something used twice a month.

**Sort order** is either `Manual` — the `sortOrder` column, dragged or nudged
with `Alt`+arrows — or `Most used`, a frecency score where a launch a week old
counts half as much as one today. **View** is a dense grid or a compact list.

Both of those, and the launch counts behind `Most used`, are `localStorage`
only. They are per-device preferences rather than records: how you reach a tool
on this phone is not a fact about the tool, so it needs no column, no migration
and no conflict rule.

## Design notes

### Colour

Semantic paired tokens — `--bg` / `--surface` / `--surface-2` /
`--surface-sunken`, `--fg` / `--fg-muted` / `--fg-subtle`, `--border` /
`--border-strong`, `--primary` / `--on-primary`, `--ring` — matching the
standard the `dough` app set. Elevation comes from surface lightness, not from
stacked shadows.

Every pair is contrast-checked rather than eyeballed: body text clears 4.5:1 on
whatever surface it sits on, and control boundaries and the focus ring clear
3:1. The focus ring is its own `--ring` token and never the card's accent — an
accent-coloured ring measured 1.6:1 on a citrus card, invisible exactly when a
keyboard user needs it.

Each card's accent is confined to its **icon tile**, as an explicit
tile-plus-glyph hex pair per theme. A wall where every card is a coloured panel
has no hierarchy, and a guessed alpha is how the previous palette ended up with
white glyphs at 1.6:1 on citrus.

The stylesheet deliberately avoids `oklch`, `color-mix`, `backdrop-filter` and
container queries, for the same reason the `dough` app does: these pages get
opened on older phones, where a half-supported colour function degrades to
something unreadable rather than something plain.

### Theme

Two states: `light` and `dark`, chosen explicitly and never inferred from the
OS. `<html>` always carries `data-theme`, so the theme is a fact in the markup
rather than a media-query outcome — the page renders correctly even with
JavaScript blocked, and the stylesheet contains no `prefers-color-scheme` rule
at all. Dark is the default on a first visit, and a `hut.theme` value left over
from an older build (such as `system`) falls back to dark rather than breaking.

The CSP-hashed boot script only has to override the markup default when the
stored choice is light — **its hash in the CSP must be recomputed whenever that
script changes.**

### Motion

Launching a tool is this app's 100+/day action, so it is not animated at all: a
bounce seen twenty times a day is friction, and the page navigates away before
it finishes. Hovers are a 120ms colour change. What remains animates on
`transform` and `opacity` only.

`prefers-reduced-motion: reduce` drops the transforms and the pulse but keeps
the opacity and colour changes that carry meaning — reduced motion means
gentler, not absent, and blanket-killing every transition removes information.

### Reordering

Pointer Events, not HTML5 drag-and-drop, because HTML5 DnD does not fire on
touch at all. `Alt` + `←`/`→` on a focused card does the same job from the
keyboard and announces where the card landed. Both are disabled in `Most used`
order, where a drag handle would promise something it cannot keep.

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
