/* ============================================================
   SUPABASE CONNECTION — public config

   All three values below are safe to publish. The publishable key is designed
   to ship in page source; it grants nothing on its own. The `hut` schema has
   RLS enabled with a per-user policy scoped to the `authenticated` role, and
   `anon` is revoked from the schema itself — not merely from the table — so
   this key can only be used to attempt a sign-in. The protection is the
   row-level security, not the secrecy of this file.

   The service_role key is a completely different thing. It bypasses RLS.
   It must never appear here, in any other file in this repo, or anywhere
   in the browser.

   WHERE TO GET THESE
     Supabase Dashboard -> Project Settings -> API
       url            = "Project URL"   (https://<ref>.supabase.co)
       publishableKey = "Project API keys" -> publishable (`sb_publishable_...`)
       schema         = the app's exposed Postgres schema (`hut`)

   HOW TO SIGN IN
     There is no sign-up flow on purpose. Create the login yourself:
     Dashboard -> Authentication -> Users -> Add user -> "Create new user",
     with "Auto Confirm User" ticked so it works without an email round trip.
     The same account already signs in to Docket, Lists, Daily and Prompts —
     Hut is another schema in the same project, not another login.
   ============================================================ */

window.SUPABASE_CONFIG = {
  // These are committed directly rather than injected at deploy time, because
  // GitHub Pages serves this repository from the branch with no build step.
  // That is safe: the publishable key is designed to ship in page source and
  // grants nothing on its own -- the protection is the row-level security
  // described in the README, not the secrecy of this value.
  //
  // Never put a service-role/secret key here. It bypasses every RLS policy in
  // the project, and this file is world-readable.
  url: 'https://baiojghilzxhkebfblzv.supabase.co',
  publishableKey: 'sb_publishable_nfLVr5Krdld9pxxr4f2CYQ_bsn0TNxx',
  schema: 'hut'
};
