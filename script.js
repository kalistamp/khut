/* ============================================================
   KALISTAMP HUT — state, rendering and the UI

   supabase.js owns every database and auth call; this file owns the state and
   calls in. Nothing here builds a Supabase client or knows a table name.

   STORAGE MODEL
     Hut NEVER requires a sign-in. It is a home base: you sign in to the tools
     it launches, if those tools want it, not to the launcher. Adding, editing,
     deleting and reordering all work signed out and persist in localStorage.

     Signing in is opt-in cloud sync and nothing else. It carries the same wall
     to your other devices, using hut.tools in Supabase, per account. That is
     also why the six starter tools are the DEFAULT_TOOLS constant below rather
     than rows inserted by a migration: the page has to work with no account,
     no network and no database.
   ============================================================ */

(function () {
  'use strict';

  const cloud = window.HutCloud;

  // Fixed base so the seeded ids are the same on every device that seeds, and
  // re-seeding the same account cannot produce six duplicate cards. Live cards
  // added through the UI use Date.now(), which is far above this.
  const SEED_BASE = 1756684800000;

  const DEFAULT_TOOLS = [
    { name: 'SC',      url: 'https://kalistamp.github.io/sc/',      icon: 'cycle', iconKind: 'svg',   accent: 'orchid', description: 'Safe Cycle Studio — draft, check and schedule posts' },
    { name: 'Docket',  url: 'https://kalistamp.github.io/doc/',     icon: '\u{1F5C2}️', iconKind: 'emoji', accent: 'lagoon', description: 'Notes, files and sharing' },
    { name: 'Lists',   url: 'https://kalistamp.github.io/lists/',   icon: '\u{1F9F9}', iconKind: 'emoji', accent: 'mint',   description: "Chores and the day's plan" },
    { name: 'Daily',   url: 'https://kalistamp.github.io/daily/',   icon: 'bolt',  iconKind: 'svg',   accent: 'citrus', description: 'Journal review and reflection' },
    { name: 'Prompts', url: 'https://kalistamp.github.io/prompts/', icon: '\u{1F4A1}', iconKind: 'emoji', accent: 'ember',  description: 'The prompt library' },
    { name: 'News',    url: 'https://kalistampai.github.io/news/',  icon: 'globe', iconKind: 'svg',   accent: 'slate',  description: 'Aggregated headlines' }
  ].map((tool, index) => ({ ...tool, id: SEED_BASE + index * 1000, sortOrder: (index + 1) * 10 }));

  const SVG_GLYPHS = ['rocket', 'bolt', 'box', 'note', 'bulb', 'globe',
                      'gear', 'star', 'cycle', 'wave', 'spark', 'heart'];

  const EMOJI_PICKS = ['\u{1F5C2}️', '\u{1F9F9}', '\u{1F4A1}', '\u{1F4F0}', '\u{267B}️',
                       '\u{1F680}', '\u{1F9F0}', '\u{1F4DA}', '\u{1F9EA}', '\u{1F3AF}',
                       '\u{1F4C8}', '\u{1F5A5}️', '\u{1F3B2}', '\u{1F334}', '\u{1F41B}', '\u{2728}'];

  const LS = {
    tools: 'hut.tools',
    theme: 'hut.theme'
  };

  const SAVE_DEBOUNCE_MS = 700;
  const TILT_DEGREES = 7;

  /* ── state ────────────────────────────────────────────── */

  const state = {
    tools: [],
    signedIn: false,
    email: '',
    // Row deltas waiting to go out. Editing one card never rewrites the rest.
    dirty: new Set(),
    removed: new Set(),
    saveTimer: null,
    editingId: null,
    pendingDeleteId: null,
    draft: { icon: '\u{1F9F0}', iconKind: 'emoji', accent: 'ember' }
  };

  const $ = (id) => document.getElementById(id);

  const el = {
    grid: $('grid'),
    empty: $('emptyState'),
    pill: $('syncPill'),
    addBtn: $('addBtn'),
    authBtn: $('authBtn'),
    themeBtn: $('themeBtn'),
    toast: $('toast'),

    toolDialog: $('toolDialog'),
    toolForm: $('toolForm'),
    toolDialogTitle: $('toolDialogTitle'),
    fName: $('fName'),
    fUrl: $('fUrl'),
    fDescription: $('fDescription'),
    fEmoji: $('fEmoji'),
    emojiPane: $('emojiPane'),
    svgPane: $('svgPane'),
    emojiPicks: $('emojiPicks'),
    svgPicks: $('svgPicks'),
    accentPicks: $('accentPicks'),
    tabEmoji: $('tabEmoji'),
    tabSvg: $('tabSvg'),
    toolError: $('toolError'),
    toolDelete: $('toolDelete'),
    toolCancel: $('toolCancel'),

    authDialog: $('authDialog'),
    authForm: $('authForm'),
    fEmail: $('fEmail'),
    fPassword: $('fPassword'),
    authError: $('authError'),
    authSubmit: $('authSubmit'),
    authCancel: $('authCancel'),

    confirmDialog: $('confirmDialog'),
    confirmText: $('confirmText'),
    confirmOk: $('confirmOk'),
    confirmCancel: $('confirmCancel')
  };

  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const lessMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ── small helpers ────────────────────────────────────── */

  function byOrder(a, b) {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id - b.id;
  }

  function hostOf(url) {
    try { return new URL(url).host; } catch (_) { return ''; }
  }

  let toastTimer = null;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
  }

  function setPill(kind, label) {
    el.pill.className = 'pill pill-' + kind;
    el.pill.textContent = label;
  }

  function svgIcon(name, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (size) { svg.setAttribute('width', size); svg.setAttribute('height', size); }
    const use = document.createElementNS(NS, 'use');
    // href, not xlink:href — every browser that runs this supports it.
    use.setAttribute('href', '#hut-' + name);
    svg.appendChild(use);
    return svg;
  }

  /* ── local cache ──────────────────────────────────────── */

  function cacheRead() {
    try {
      const raw = localStorage.getItem(LS.tools);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.length ? parsed : null;
    } catch (_) { return null; }
  }

  function cacheWrite() {
    try { localStorage.setItem(LS.tools, JSON.stringify(state.tools)); } catch (_) {}
  }

  /* ── rendering ────────────────────────────────────────── */

  /* The card is an <a>, and the edit/delete/reorder controls are buttons. A
     button inside an anchor is invalid HTML, and its click bubbles to the
     anchor and navigates away. So the two are siblings inside a positioned
     slot, and the slot -- not the card -- is the grid item and the drag unit. */
  function buildCard(tool) {
    const slot = document.createElement('div');
    slot.className = 'card-slot';
    slot.dataset.id = String(tool.id);

    const card = document.createElement('a');
    card.className = 'card accent-' + tool.accent;
    card.href = tool.url;
    card.rel = 'noopener noreferrer';

    const icon = document.createElement('span');
    icon.className = 'card-icon';
    icon.setAttribute('aria-hidden', 'true');
    if (tool.iconKind === 'svg') icon.appendChild(svgIcon(tool.icon));
    else icon.textContent = tool.icon;
    card.appendChild(icon);

    const name = document.createElement('h2');
    name.className = 'card-name';
    name.textContent = tool.name;
    card.appendChild(name);

    if (tool.description) {
      const desc = document.createElement('p');
      desc.className = 'card-desc';
      desc.textContent = tool.description;
      card.appendChild(desc);
    }

    const host = document.createElement('p');
    host.className = 'card-host';
    host.textContent = hostOf(tool.url);
    card.appendChild(host);

    const rule = document.createElement('span');
    rule.className = 'card-rule';
    rule.setAttribute('aria-hidden', 'true');
    card.appendChild(rule);

    slot.appendChild(card);
    slot.appendChild(buildMenu(tool));

    bindCard(card, tool);
    return slot;
  }

  function buildMenu(tool) {
    const menu = document.createElement('span');
    menu.className = 'card-menu';

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'icon-btn drag-handle';
    handle.title = 'Drag to reorder (or focus and press the arrow keys)';
    handle.setAttribute('aria-label', 'Reorder ' + tool.name);
    handle.appendChild(svgIcon('box', 15));
    handle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    menu.appendChild(handle);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'icon-btn';
    edit.title = 'Edit';
    edit.setAttribute('aria-label', 'Edit ' + tool.name);
    edit.appendChild(svgIcon('gear', 15));
    edit.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openToolDialog(tool.id);
    });
    menu.appendChild(edit);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn';
    remove.title = 'Delete';
    remove.setAttribute('aria-label', 'Delete ' + tool.name);
    remove.textContent = '✕';
    remove.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      askDelete(tool.id);
    });
    menu.appendChild(remove);

    bindDrag(handle);
    return menu;
  }

  function render() {
    const sorted = state.tools.slice().sort(byOrder);
    el.grid.textContent = '';
    for (const tool of sorted) el.grid.appendChild(buildCard(tool));

    el.empty.hidden = sorted.length > 0;
  }

  /* ── card interactions ────────────────────────────────── */

  function bindCard(card, tool) {
    // The tilt and the cursor glow only exist where there is a real pointer to
    // drive them. On touch the CSS press-scale does the job instead.
    if (finePointer.matches && !lessMotion.matches) {
      let frame = 0;
      card.addEventListener('pointermove', (event) => {
        if (frame) return;
        // One update per frame. A raw pointermove handler fires far faster
        // than the compositor can use and is what makes this pattern janky
        // on the older phones these pages get opened on.
        frame = requestAnimationFrame(() => {
          frame = 0;
          const rect = card.getBoundingClientRect();
          const px = (event.clientX - rect.left) / rect.width;
          const py = (event.clientY - rect.top) / rect.height;
          card.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
          card.style.setProperty('--my', (py * 100).toFixed(1) + '%');
          card.style.setProperty('--ry', ((px - 0.5) * TILT_DEGREES * 2).toFixed(2) + 'deg');
          card.style.setProperty('--rx', (-(py - 0.5) * TILT_DEGREES * 2).toFixed(2) + 'deg');
        });
      });

      card.addEventListener('pointerleave', () => {
        cancelAnimationFrame(frame);
        frame = 0;
        card.style.setProperty('--rx', '0deg');
        card.style.setProperty('--ry', '0deg');
      });
    }

    card.addEventListener('click', (event) => {
      // A drag that ended on the card must not also launch it.
      if (drag.active || drag.justDropped) {
        event.preventDefault();
        return;
      }
      if (lessMotion.matches) return;
      card.classList.add('launching');
      setTimeout(() => card.classList.remove('launching'), 340);
    });

    // Keyboard reordering, so the drag handle is not the only way.
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (!event.altKey) return;
      event.preventDefault();
      moveTool(tool.id, event.key === 'ArrowLeft' ? -1 : 1);
    });
  }

  /* ── drag to reorder ──────────────────────────────────── */

  /* Pointer Events rather than HTML5 drag-and-drop: HTML5 DnD does not fire on
     touch at all, and half of these cards get reordered on a phone. */
  const drag = { active: false, card: null, justDropped: false };

  function bindDrag(handle) {
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();

      const card = handle.closest('.card-slot');
      if (!card) return;

      drag.active = true;
      drag.card = card;
      card.classList.add('dragging');
      handle.setPointerCapture(event.pointerId);

      const onMove = (moveEvent) => {
        if (!drag.active) return;
        const under = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
        const target = under && under.closest ? under.closest('.card-slot') : null;
        if (!target || target === card || target.parentNode !== el.grid) return;

        // Insert before or after depending on which half was entered, so a
        // slow drag does not oscillate across the midpoint.
        const rect = target.getBoundingClientRect();
        const after = (moveEvent.clientX - rect.left) > rect.width / 2;
        el.grid.insertBefore(card, after ? target.nextSibling : target);
      };

      const onUp = () => {
        if (!drag.active) return;
        drag.active = false;
        card.classList.remove('dragging');
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        commitOrder();
        // Swallow the click the pointerup is about to synthesise.
        drag.justDropped = true;
        setTimeout(() => { drag.justDropped = false; }, 0);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }

  // Read the order back off the DOM and renumber. Only the rows whose position
  // actually changed are queued, so dragging one card pushes one or two rows,
  // not the whole wall.
  function commitOrder() {
    const ids = Array.from(el.grid.children).map(node => Number(node.dataset.id));
    let changed = false;
    ids.forEach((id, index) => {
      const tool = state.tools.find(t => t.id === id);
      const next = (index + 1) * 10;
      if (tool && tool.sortOrder !== next) {
        tool.sortOrder = next;
        state.dirty.add(id);
        changed = true;
      }
    });
    if (changed) { cacheWrite(); queueSave(); }
  }

  function moveTool(id, direction) {
    const sorted = state.tools.slice().sort(byOrder);
    const from = sorted.findIndex(tool => tool.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= sorted.length) return;
    sorted.splice(to, 0, sorted.splice(from, 1)[0]);
    sorted.forEach((tool, index) => {
      const next = (index + 1) * 10;
      if (tool.sortOrder !== next) { tool.sortOrder = next; state.dirty.add(tool.id); }
    });
    cacheWrite();
    render();
    // Keep the moved card focused so a run of Alt+Arrow keeps working.
    const moved = el.grid.querySelector('.card-slot[data-id="' + id + '"] .card');
    if (moved) moved.focus();
    queueSave();
  }

  /* ── the tool editor ──────────────────────────────────── */

  function paintPicks() {
    el.emojiPicks.textContent = '';
    for (const emoji of EMOJI_PICKS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pick';
      button.textContent = emoji;
      button.setAttribute('aria-pressed',
        String(state.draft.iconKind === 'emoji' && state.draft.icon === emoji));
      button.addEventListener('click', () => {
        state.draft.icon = emoji;
        state.draft.iconKind = 'emoji';
        el.fEmoji.value = emoji;
        paintPicks();
      });
      el.emojiPicks.appendChild(button);
    }

    el.svgPicks.textContent = '';
    for (const glyph of SVG_GLYPHS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pick';
      button.title = glyph;
      button.setAttribute('aria-label', glyph);
      button.setAttribute('aria-pressed',
        String(state.draft.iconKind === 'svg' && state.draft.icon === glyph));
      button.appendChild(svgIcon(glyph, 22));
      button.addEventListener('click', () => {
        state.draft.icon = glyph;
        state.draft.iconKind = 'svg';
        paintPicks();
      });
      el.svgPicks.appendChild(button);
    }

    el.accentPicks.textContent = '';
    for (const accent of cloud.ACCENTS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch accent-' + accent;
      button.title = accent;
      button.setAttribute('aria-label', accent);
      button.setAttribute('aria-pressed', String(state.draft.accent === accent));
      button.addEventListener('click', () => {
        state.draft.accent = accent;
        paintPicks();
      });
      el.accentPicks.appendChild(button);
    }

    const emojiActive = state.draft.iconKind === 'emoji';
    el.tabEmoji.setAttribute('aria-selected', String(emojiActive));
    el.tabSvg.setAttribute('aria-selected', String(!emojiActive));
    el.emojiPane.hidden = !emojiActive;
    el.svgPane.hidden = emojiActive;
  }

  function openToolDialog(id) {
    state.editingId = id == null ? null : id;
    const tool = id == null ? null : state.tools.find(t => t.id === id);

    el.toolDialogTitle.textContent = tool ? 'Edit tool' : 'Add tool';
    el.fName.value = tool ? tool.name : '';
    el.fUrl.value = tool ? tool.url : '';
    el.fDescription.value = tool ? tool.description : '';
    el.fEmoji.value = tool && tool.iconKind === 'emoji' ? tool.icon : '';
    state.draft = {
      icon: tool ? tool.icon : '\u{1F9F0}',
      iconKind: tool ? tool.iconKind : 'emoji',
      accent: tool ? tool.accent : 'ember'
    };
    el.toolDelete.hidden = !tool;
    el.toolError.hidden = true;

    paintPicks();
    el.toolDialog.showModal();
    el.fName.focus();
  }

  function saveTool() {
    const name = el.fName.value.trim();
    const url = cloud.validUrl(el.fUrl.value);
    const description = el.fDescription.value.trim();

    if (!name) return showToolError('Give the tool a name.');
    if (!url) return showToolError('The URL must start with https://');

    // A typed emoji beats the picker, so the field is not a dead end for an
    // emoji that is not in the sixteen offered.
    let icon = state.draft.icon;
    let iconKind = state.draft.iconKind;
    const typed = el.fEmoji.value.trim();
    if (!el.emojiPane.hidden && typed) { icon = typed; iconKind = 'emoji'; }

    if (state.editingId != null) {
      const tool = state.tools.find(t => t.id === state.editingId);
      if (!tool) return showToolError('That card is no longer here.');
      Object.assign(tool, { name, url, description, icon, iconKind, accent: state.draft.accent });
      state.dirty.add(tool.id);
    } else {
      const highest = state.tools.reduce((max, t) => Math.max(max, t.sortOrder), 0);
      const tool = {
        id: Date.now(),
        name, url, description, icon, iconKind,
        accent: state.draft.accent,
        sortOrder: highest + 10
      };
      state.tools.push(tool);
      state.dirty.add(tool.id);
    }

    el.toolDialog.close();
    cacheWrite();
    render();
    queueSave();
    return true;
  }

  function showToolError(message) {
    el.toolError.textContent = message;
    el.toolError.hidden = false;
    return false;
  }

  function askDelete(id) {
    const tool = state.tools.find(t => t.id === id);
    if (!tool) return;
    state.pendingDeleteId = id;
    el.confirmText.textContent =
      'This removes the “' + tool.name + '” card from the Hut. The tool itself is untouched.';
    el.confirmDialog.showModal();
  }

  function doDelete() {
    const id = state.pendingDeleteId;
    state.pendingDeleteId = null;
    el.confirmDialog.close();
    if (id == null) return;

    state.tools = state.tools.filter(tool => tool.id !== id);
    state.dirty.delete(id);
    state.removed.add(id);
    cacheWrite();
    render();
    queueSave();
    toast('Card deleted.');
  }

  /* ── sync ─────────────────────────────────────────────── */

  function queueSave() {
    if (!state.signedIn) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }

  async function flush() {
    if (!state.signedIn) return;
    if (!state.dirty.size && !state.removed.size) return;

    const dirtyIds = Array.from(state.dirty);
    const removedIds = Array.from(state.removed);
    state.dirty.clear();
    state.removed.clear();

    setPill('sync', 'Saving…');
    try {
      const rows = dirtyIds
        .map(id => state.tools.find(tool => tool.id === id))
        .filter(Boolean);
      if (rows.length) await cloud.pushTools(rows);
      if (removedIds.length) await cloud.deleteTools(removedIds);
      setPill('synced', 'Synced');
    } catch (error) {
      // Put the delta back so the next change retries it rather than losing it.
      dirtyIds.forEach(id => state.dirty.add(id));
      removedIds.forEach(id => state.removed.add(id));
      setPill('error', 'Sync failed');
      toast('Could not save: ' + (error && error.message ? error.message : 'unknown error'));
    }
  }

  /* Signing in MERGES; it never overwrites. Because the wall is fully editable
     signed out, by the time an account is attached this device may already
     hold cards and edits that exist nowhere else, and a plain overwrite would
     throw them away. Three rules, all consistent with the per-row
     last-writer-wins model:

       · a card only this device has  -> kept, and pushed up
       · a card edited here and not yet pushed -> this device wins
       · anything else -> the cloud row wins

     A card deleted here while signed out stays deleted: the pending delete is
     in state.removed, so the returning cloud row is dropped and flush() then
     removes it upstream. */
  async function loadFromCloud() {
    setPill('sync', 'Loading…');
    try {
      const { tools } = await cloud.pull();
      const local = state.tools;

      if (!tools.length) {
        // Nothing up there yet: the account adopts this device's wall, whether
        // that is the untouched six or a set already curated offline.
        state.tools = local.map(tool => ({ ...tool }));
        state.tools.forEach(tool => state.dirty.add(tool.id));
        cacheWrite();
        render();
        await flush();
        toast('Your Hut is now synced to this account.');
        return;
      }

      const pending = state.dirty;
      const merged = tools
        .filter(row => !state.removed.has(row.id))
        .map(row => (pending.has(row.id) ? (local.find(t => t.id === row.id) || row) : row));

      const remoteIds = new Set(tools.map(tool => tool.id));
      const localOnly = local.filter(tool => !remoteIds.has(tool.id) && !state.removed.has(tool.id));
      localOnly.forEach(tool => state.dirty.add(tool.id));

      state.tools = merged.concat(localOnly);
      cacheWrite();
      render();

      if (state.dirty.size || state.removed.size) await flush();
      else setPill('synced', 'Synced');
    } catch (error) {
      // The wall is already on screen from the cache, so a failed pull costs
      // nothing but the sync. Say so and carry on.
      setPill('error', 'Offline');
      toast('Could not reach the cloud — your cards are still saved on this device.');
    }
  }

  /* ── auth ─────────────────────────────────────────────── */

  function openAuthDialog() {
    el.authError.hidden = true;
    el.authDialog.showModal();
    el.fEmail.focus();
  }

  async function doSignIn() {
    const email = el.fEmail.value.trim();
    const password = el.fPassword.value;
    if (!email || !password) return;

    el.authSubmit.disabled = true;
    el.authSubmit.textContent = 'Signing in…';
    try {
      const result = await cloud.signIn(email, password);
      if (!result.ok) {
        el.authError.textContent = result.error;
        el.authError.hidden = false;
        return;
      }
      el.fPassword.value = '';
      el.authDialog.close();
    } finally {
      el.authSubmit.disabled = false;
      el.authSubmit.textContent = 'Sign in';
    }
  }

  function applySession(session) {
    state.signedIn = !!session;
    state.email = session && session.user ? session.user.email || '' : '';
    el.authBtn.textContent = state.signedIn ? 'Sign out' : 'Sign in';
    // The account is worth showing, but on the control that acts on it rather
    // than as a line of prose under the cards.
    el.authBtn.title = state.signedIn
      ? 'Signed in as ' + state.email
      : 'Optional — sync your cards across devices';
    if (!state.signedIn) setPill('idle', 'Local');
    render();
  }

  /* ── theme ────────────────────────────────────────────── */

  function applyThemeLabel() {
    const dark = document.documentElement.classList.contains('theme-dark');
    el.themeBtn.setAttribute('aria-label',
      dark ? 'Switch to light mode' : 'Switch to dark mode');
  }

  function toggleTheme() {
    const root = document.documentElement;
    const dark = root.classList.toggle('theme-dark');
    try { localStorage.setItem(LS.theme, dark ? 'dark' : 'light'); } catch (_) {}
    applyThemeLabel();
  }

  /* ── wiring ───────────────────────────────────────────── */

  el.addBtn.addEventListener('click', () => openToolDialog(null));

  el.authBtn.addEventListener('click', async () => {
    if (!state.signedIn) { openAuthDialog(); return; }
    await cloud.signOut();
    // The wall stays exactly as it is — it is in localStorage too. Only the
    // pending cloud delta is dropped, because there is no longer an account
    // to push it to.
    state.dirty.clear();
    state.removed.clear();
    applySession(null);
    toast('Signed out. Your cards stay on this device.');
  });

  el.themeBtn.addEventListener('click', toggleTheme);

  el.toolForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveTool();
  });
  el.toolCancel.addEventListener('click', () => el.toolDialog.close());
  el.toolDelete.addEventListener('click', () => {
    const id = state.editingId;
    el.toolDialog.close();
    if (id != null) askDelete(id);
  });
  el.tabEmoji.addEventListener('click', () => { state.draft.iconKind = 'emoji'; paintPicks(); });
  el.tabSvg.addEventListener('click', () => { state.draft.iconKind = 'svg'; paintPicks(); });

  el.authForm.addEventListener('submit', (event) => {
    event.preventDefault();
    doSignIn();
  });
  el.authCancel.addEventListener('click', () => el.authDialog.close());

  el.confirmOk.addEventListener('click', doDelete);
  el.confirmCancel.addEventListener('click', () => {
    state.pendingDeleteId = null;
    el.confirmDialog.close();
  });

  // A pending delta must not be lost to a tab close.
  window.addEventListener('beforeunload', () => {
    if (state.dirty.size || state.removed.size) flush();
  });

  /* ── boot ─────────────────────────────────────────────── */

  async function boot() {
    applyThemeLabel();

    // Paint before touching the network: cache first, constants if there is no
    // cache. The wall is usable and launchable before Supabase answers.
    state.tools = cacheRead() || DEFAULT_TOOLS.map(tool => ({ ...tool }));
    render();

    if (!cloud.configured()) {
      // The pill is the whole status surface. In a deployed build this branch
      // is unreachable: the workflow fails if the placeholders survive.
      setPill('idle', 'Local only');
      el.authBtn.hidden = true;
      return;
    }

    cloud.onAuthChange((event, session) => {
      applySession(session);
      if (session) loadFromCloud();
    });

    const session = await cloud.getSession();
    applySession(session);
    if (session) loadFromCloud();
  }

  boot();

  // agent-facing surface, matching the window.<App> convention in the other
  // repos. Nothing here reaches Supabase directly.
  window.HutApp = {
    state,
    render,
    addTool: () => openToolDialog(null),
    DEFAULT_TOOLS
  };
})();
