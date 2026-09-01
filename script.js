/* ============================================================
   KALISTAMP HUT — state, rendering and the UI

   supabase.js owns every database and auth call; this file owns the state and
   calls in. Nothing here builds a Supabase client or knows a table name.

   STORAGE MODEL
     VIEWING and LAUNCHING never require a sign-in -- that is the point of a
     home base, and each tool asks for its own login if it wants one.
     MANAGING the wall does: add, edit, delete and reorder all sit behind the
     sign-in, so someone who finds the URL is shown a launcher, not an editor.

     To be precise about what that gate is and is not: an anonymous visitor
     could never have reached your data anyway. hut.tools is behind RLS, every
     policy tests auth.uid() = user_id, and `anon` is revoked from the schema
     itself. The gate removes a MISLEADING AFFORDANCE -- edit controls that
     imply the page is world-editable -- rather than closing a hole.

     The record is hut.tools in Supabase, per account. localStorage is the
     first-paint cache and the signed-out view, not the record. That is why the
     six starter tools are the DEFAULT_TOOLS constant below rather than rows
     inserted by a migration: the page has to paint before the database
     answers, and before there is an account at all.

   WHAT IS DELIBERATELY LOCAL
     Launch counts (hut.usage), the view mode and the sort mode are per-device
     preferences, not records. They live only in localStorage, which is why
     "Most used" needed no migration and no new column: how you reach a tool on
     this phone is not a fact about the tool.
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
    theme: 'hut.theme',
    usage: 'hut.usage',
    view:  'hut.view',
    order: 'hut.order'
  };

  const SAVE_DEBOUNCE_MS = 700;

  // A launch a week old counts half as much as one today. Long enough that a
  // tool used every few days holds its place, short enough that the wall
  // follows what you are actually working on this month.
  const FRECENCY_HALFLIFE_MS = 7 * 24 * 60 * 60 * 1000;

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
    draft: { icon: '\u{1F9F0}', iconKind: 'emoji', accent: 'ember' },
    usage: {},
    view: 'grid',      // grid | list
    order: 'manual',   // manual | frecency
    theme: 'system',   // system | light | dark
    palette: { open: false, items: [], index: 0 }
  };

  const $ = (id) => document.getElementById(id);

  const el = {
    grid: $('grid'),
    empty: $('emptyState'),
    emptyAdd: $('emptyAdd'),
    count: $('toolCount'),
    pill: $('syncPill'),
    addBtn: $('addBtn'),
    authBtn: $('authBtn'),
    themeBtn: $('themeBtn'),
    themeIcon: $('themeIcon'),
    searchBtn: $('searchBtn'),
    searchKbd: $('searchKbd'),
    toast: $('toast'),

    orderManual: $('orderManual'),
    orderFrecency: $('orderFrecency'),
    viewGrid: $('viewGrid'),
    viewList: $('viewList'),

    paletteDialog: $('paletteDialog'),
    paletteInput: $('paletteInput'),
    paletteList: $('paletteList'),

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
    // The region is always in the DOM; only its text changes. Toggling
    // `hidden` meant the text was already there when the region entered the
    // accessibility tree, and screen readers announced nothing.
    el.toast.textContent = message;
    el.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.classList.remove('is-visible'); }, 3200);
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

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) { return fallback; }
  }

  function writeLocal(key, value) {
    try { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); }
    catch (_) {}
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
    writeLocal(LS.tools, state.tools);
  }

  /* ── frecency ─────────────────────────────────────────── */

  /* Per-device, localStorage only. A launch count is not a fact about the
     tool -- it is a fact about this browser -- so it never goes near the
     database and needs no column, no migration and no conflict rule. */

  function usageScore(id) {
    const entry = state.usage[id];
    if (!entry || !entry.count) return 0;
    const age = Date.now() - (entry.last || 0);
    if (age < 0) return entry.count;
    return entry.count * Math.pow(0.5, age / FRECENCY_HALFLIFE_MS);
  }

  function noteLaunch(id) {
    const entry = state.usage[id] || { count: 0, last: 0 };
    entry.count += 1;
    entry.last = Date.now();
    state.usage[id] = entry;
    writeLocal(LS.usage, state.usage);
    // Re-sorting under the user's finger mid-launch would be disorienting, so
    // the new order lands on the next paint, not this one.
  }

  function sortedTools() {
    const list = state.tools.slice();
    if (state.order === 'frecency') {
      return list.sort((a, b) => {
        const diff = usageScore(b.id) - usageScore(a.id);
        if (diff) return diff;
        // Never-launched tools keep a stable, predictable order rather than
        // shuffling on every render.
        return a.name.localeCompare(b.name);
      });
    }
    return list.sort(byOrder);
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
    // Validated again on the way out, not only on the way in. A stored
    // `javascript:` URL would be a script-injection path straight into an
    // href, and the page's CSP has no unsafe-inline to fall back on.
    const safe = cloud.validUrl(tool.url);
    if (safe) {
      card.href = safe;
      card.rel = 'noopener noreferrer';
    } else {
      card.setAttribute('role', 'link');
      card.setAttribute('aria-disabled', 'true');
    }

    const icon = document.createElement('span');
    icon.className = 'card-icon';
    icon.setAttribute('aria-hidden', 'true');
    if (tool.iconKind === 'svg') icon.appendChild(svgIcon(tool.icon));
    else icon.textContent = tool.icon;
    card.appendChild(icon);

    // A wrapper so the list view can lay icon / text / host out as a row
    // without the grid view needing a different element tree.
    const body = document.createElement('span');
    body.className = 'card-body';

    const name = document.createElement('span');
    name.className = 'card-name';
    name.textContent = tool.name;
    body.appendChild(name);

    if (tool.description) {
      const desc = document.createElement('span');
      desc.className = 'card-desc';
      desc.textContent = tool.description;
      body.appendChild(desc);
    }
    card.appendChild(body);

    const host = document.createElement('span');
    host.className = 'card-host';
    host.textContent = hostOf(tool.url);
    card.appendChild(host);

    slot.appendChild(card);
    if (state.signedIn) slot.appendChild(buildMenu(tool));

    bindCard(card, tool);
    return slot;
  }

  function buildMenu(tool) {
    const menu = document.createElement('span');
    menu.className = 'card-menu';

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'icon-btn drag-handle';
    handle.title = 'Drag to reorder (or focus the card and press Alt with the arrow keys)';
    handle.setAttribute('aria-label', 'Reorder ' + tool.name);
    handle.appendChild(svgIcon('ui-grip', 14));
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
    edit.appendChild(svgIcon('ui-pencil', 14));
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
    remove.appendChild(svgIcon('ui-trash', 14));
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
    const sorted = sortedTools();
    el.grid.textContent = '';
    for (const tool of sorted) el.grid.appendChild(buildCard(tool));

    el.grid.classList.toggle('view-list', state.view === 'list');
    el.grid.classList.toggle('order-frecency', state.order === 'frecency');
    el.empty.hidden = sorted.length > 0;
    updateCount(sorted.length);
  }

  function updateCount(n) {
    el.count.textContent = n === 1 ? '1 tool' : n + ' tools';
  }

  /* ── card interactions ────────────────────────────────── */

  function bindCard(card, tool) {
    card.addEventListener('click', (event) => {
      // A drag that ended on the card must not also launch it.
      if (drag.active || drag.justDropped) {
        event.preventDefault();
        return;
      }
      noteLaunch(tool.id);
    });

    card.addEventListener('keydown', (event) => {
      // Alt + arrows reorder; bare arrows walk the wall. Both are here rather
      // than on the grid so the handler always knows which card it is on.
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' &&
          event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

      if (event.altKey) {
        if (!state.signedIn || state.order !== 'manual') return;
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        moveTool(tool.id, event.key === 'ArrowLeft' ? -1 : 1);
        return;
      }

      event.preventDefault();
      focusNeighbour(card, event.key);
    });
  }

  /* Arrow-key navigation across the wall. Columns are measured from the laid
     out DOM rather than assumed, so it follows whatever the grid actually did
     at this width -- including the single-column phone layout and list view. */
  function focusNeighbour(card, key) {
    const cards = Array.from(el.grid.querySelectorAll('.card'));
    const from = cards.indexOf(card);
    if (from < 0) return;

    let columns = 1;
    if (cards.length > 1) {
      const top = cards[0].getBoundingClientRect().top;
      columns = cards.findIndex(c => c.getBoundingClientRect().top > top + 1);
      if (columns < 1) columns = cards.length;
    }

    const step = (key === 'ArrowLeft') ? -1
               : (key === 'ArrowRight') ? 1
               : (key === 'ArrowUp') ? -columns : columns;

    const to = from + step;
    if (to < 0 || to >= cards.length) return;
    cards[to].focus();
  }

  /* ── drag to reorder ──────────────────────────────────── */

  /* Pointer Events rather than HTML5 drag-and-drop: HTML5 DnD does not fire on
     touch at all, and half of these cards get reordered on a phone. */
  const drag = { active: false, card: null, justDropped: false };

  function bindDrag(handle) {
    handle.addEventListener('pointerdown', (event) => {
      if (!state.signedIn || state.order !== 'manual') return;
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
        // slow drag does not oscillate across the midpoint. In list view the
        // meaningful axis is vertical, so measure the one that matters.
        const rect = target.getBoundingClientRect();
        const after = state.view === 'list'
          ? (moveEvent.clientY - rect.top) > rect.height / 2
          : (moveEvent.clientX - rect.left) > rect.width / 2;
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
    const ids = Array.from(el.grid.children)
      .filter(node => node.dataset && node.dataset.id)
      .map(node => Number(node.dataset.id));
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
    // Keep the moved card focused so a run of Alt+Arrow keeps working, and say
    // where it landed -- a silent reorder tells a screen reader nothing.
    const moved = el.grid.querySelector('.card-slot[data-id="' + id + '"] .card');
    if (moved) moved.focus();
    const tool = state.tools.find(t => t.id === id);
    if (tool) toast(tool.name + ' moved to position ' + (to + 1) + ' of ' + sorted.length + '.');
    queueSave();
  }

  /* ── command palette ──────────────────────────────────── */

  /* Type two letters, press Enter. This is the primary way into a tool once
     the wall grows past a handful, and the reason the wall itself can afford
     to be quiet. */

  function paletteActions() {
    const actions = [
      { kind: 'action', id: 'a-view', name: state.view === 'grid' ? 'Switch to list view' : 'Switch to grid view',
        hint: 'Change how the wall is laid out', icon: state.view === 'grid' ? 'ui-list' : 'ui-grid',
        run: () => setView(state.view === 'grid' ? 'list' : 'grid') },
      { kind: 'action', id: 'a-order', name: state.order === 'manual' ? 'Sort by most used' : 'Sort manually',
        hint: 'Change the order of the wall', icon: 'ui-clock',
        run: () => setOrder(state.order === 'manual' ? 'frecency' : 'manual') },
      { kind: 'action', id: 'a-theme', name: 'Switch theme', hint: 'System, light or dark', icon: 'ui-sun', run: cycleTheme }
    ];
    // Managing the wall needs a backend. Without one, offering "Add tool" only
    // leads to a sign-in sheet that can never succeed -- the topbar already
    // hides these, and the palette must agree with it.
    if (cloud.configured()) {
      actions.unshift({ kind: 'action', id: 'a-add', name: 'Add tool',
        hint: 'Create a new card', icon: 'ui-plus', run: () => openToolDialog(null) });
      actions.push(state.signedIn
        ? { kind: 'action', id: 'a-out', name: 'Sign out', hint: state.email, icon: 'ui-user', run: signOut }
        : { kind: 'action', id: 'a-in', name: 'Sign in', hint: 'Manage and sync your cards', icon: 'ui-user', run: openAuthDialog });
    }
    return actions;
  }

  /* Ranked, not merely filtered. A launcher is judged on whether the thing you
     meant is the first row after two keystrokes, so a prefix on the name beats
     a hit buried in a description. */
  function scoreMatch(text, query) {
    if (!text) return 0;
    const haystack = text.toLowerCase();
    const at = haystack.indexOf(query);
    if (at === 0) return 100;
    if (at > 0) return /\s/.test(haystack.charAt(at - 1)) ? 70 : 40;
    return 0;
  }

  function paletteMatches(query) {
    const q = query.trim().toLowerCase();
    const tools = sortedTools().map(tool => ({
      kind: 'tool', id: 't-' + tool.id, tool,
      name: tool.name, hint: tool.description || hostOf(tool.url)
    }));
    const actions = paletteActions();

    if (!q) {
      // With no query the wall's own order is the honest default -- and in
      // "most used" mode that is already the ranking the user asked for.
      return tools.concat(actions);
    }

    const rank = (item) => {
      const base = Math.max(
        scoreMatch(item.name, q) * 3,
        scoreMatch(item.hint, q),
        item.tool ? scoreMatch(hostOf(item.tool.url), q) : 0
      );
      if (!base) return 0;
      // A tie between two tools is broken by how often you actually open them.
      return base + (item.tool ? Math.min(usageScore(item.tool.id), 20) : 0);
    };

    return tools.concat(actions)
      .map(item => ({ item, score: rank(item) }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(entry => entry.item);
  }

  function renderPalette() {
    const items = state.palette.items;
    el.paletteList.textContent = '';

    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'palette-empty';
      empty.textContent = 'No tools or actions match that.';
      el.paletteList.appendChild(empty);
      el.paletteInput.removeAttribute('aria-activedescendant');
      return;
    }

    let lastKind = null;
    items.forEach((item, index) => {
      if (item.kind !== lastKind) {
        const group = document.createElement('li');
        group.className = 'palette-group';
        group.setAttribute('role', 'presentation');
        group.textContent = item.kind === 'tool' ? 'Tools' : 'Actions';
        el.paletteList.appendChild(group);
        lastKind = item.kind;
      }

      const row = document.createElement('li');
      row.className = 'palette-item';
      row.id = 'palette-' + item.id;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === state.palette.index));

      if (item.kind === 'tool') {
        const icon = document.createElement('span');
        icon.className = 'card-icon accent-' + item.tool.accent;
        icon.setAttribute('aria-hidden', 'true');
        if (item.tool.iconKind === 'svg') icon.appendChild(svgIcon(item.tool.icon));
        else icon.textContent = item.tool.icon;
        row.appendChild(icon);
      } else {
        const icon = document.createElement('span');
        icon.className = 'palette-action-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.appendChild(svgIcon(item.icon, 15));
        row.appendChild(icon);
      }

      const text = document.createElement('span');
      text.className = 'palette-text';
      const name = document.createElement('span');
      name.className = 'palette-name';
      name.textContent = item.name;
      text.appendChild(name);
      if (item.hint) {
        const sub = document.createElement('span');
        sub.className = 'palette-sub';
        sub.textContent = item.hint;
        text.appendChild(sub);
      }
      row.appendChild(text);

      row.addEventListener('click', () => choosePalette(index));
      el.paletteList.appendChild(row);
    });

    const selected = items[state.palette.index];
    if (selected) el.paletteInput.setAttribute('aria-activedescendant', 'palette-' + selected.id);
  }

  function movePalette(step) {
    const total = state.palette.items.length;
    if (!total) return;
    state.palette.index = (state.palette.index + step + total) % total;
    renderPalette();
    const active = el.paletteList.querySelector('[aria-selected="true"]');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function choosePalette(index) {
    const item = state.palette.items[index];
    if (!item) return;
    closePalette();
    if (item.kind === 'tool') {
      const safe = cloud.validUrl(item.tool.url);
      if (!safe) { toast('That card has no usable https:// address.'); return; }
      noteLaunch(item.tool.id);
      window.location.href = safe;
      return;
    }
    item.run();
  }

  function refreshPalette() {
    state.palette.items = paletteMatches(el.paletteInput.value);
    state.palette.index = 0;
    renderPalette();
  }

  function openPalette() {
    if (state.palette.open) return;
    state.palette.open = true;
    el.paletteInput.value = '';
    refreshPalette();
    el.paletteDialog.showModal();
    el.paletteInput.focus();
  }

  function closePalette() {
    if (!state.palette.open) return;
    state.palette.open = false;
    el.paletteDialog.close();
  }

  /* ── the tool editor ──────────────────────────────────── */

  function paintPicks() {
    el.emojiPicks.textContent = '';
    for (const emoji of EMOJI_PICKS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pick';
      button.textContent = emoji;
      button.setAttribute('aria-label', 'Use ' + emoji);
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
      button.appendChild(svgIcon(glyph, 20));
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

    setIconTab(state.draft.iconKind === 'emoji' ? 'emoji' : 'svg', false);
  }

  /* A real tab pattern: aria-controls, a roving tabindex and arrow keys. The
     old markup announced "tab" and then behaved like two ordinary buttons,
     which is worse than no roles at all. */
  function setIconTab(kind, focusTab) {
    const emojiActive = kind === 'emoji';
    state.draft.iconKind = kind;

    el.tabEmoji.setAttribute('aria-selected', String(emojiActive));
    el.tabSvg.setAttribute('aria-selected', String(!emojiActive));
    el.tabEmoji.tabIndex = emojiActive ? 0 : -1;
    el.tabSvg.tabIndex = emojiActive ? -1 : 0;
    el.emojiPane.hidden = !emojiActive;
    el.svgPane.hidden = emojiActive;

    if (focusTab) (emojiActive ? el.tabEmoji : el.tabSvg).focus();
  }

  function onTabKey(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' &&
        event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const toEmoji = event.key === 'Home' ? true
                  : event.key === 'End' ? false
                  : el.tabEmoji.getAttribute('aria-selected') !== 'true';
    const kind = toEmoji ? 'emoji' : 'svg';
    // paintPicks() re-reads the draft and re-applies the tab state, so set the
    // kind first, repaint, then move focus onto the tab that is now selected.
    setIconTab(kind, false);
    paintPicks();
    setIconTab(kind, true);
  }

  function openToolDialog(id) {
    // Managing the wall requires an account. Offer the way in rather than a
    // dead button: a visitor who taps "Add tool" gets the sign-in sheet.
    if (!state.signedIn) { openAuthDialog(); return; }

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
    delete state.usage[id];
    writeLocal(LS.usage, state.usage);
    cacheWrite();
    render();
    queueSave();
    toast('Card deleted.');
  }

  /* ── view and order preferences ───────────────────────── */

  function setView(view) {
    state.view = view === 'list' ? 'list' : 'grid';
    writeLocal(LS.view, state.view);
    el.viewGrid.setAttribute('aria-pressed', String(state.view === 'grid'));
    el.viewList.setAttribute('aria-pressed', String(state.view === 'list'));
    render();
  }

  function setOrder(order) {
    state.order = order === 'frecency' ? 'frecency' : 'manual';
    writeLocal(LS.order, state.order);
    el.orderManual.setAttribute('aria-pressed', String(state.order === 'manual'));
    el.orderFrecency.setAttribute('aria-pressed', String(state.order === 'frecency'));
    render();
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

  /* Signing in MERGES; it never overwrites. Editing is behind the sign-in, so
     this device cannot be carrying anonymous edits -- but it can be carrying
     edits made while signed in and offline, or before a session expired, still
     sitting unpushed in state.dirty / state.removed. A plain overwrite would
     throw those away. Three rules, all consistent with the per-row
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

  async function signOut() {
    await cloud.signOut();
    // The wall stays exactly as it is — it is in localStorage too. Only the
    // pending cloud delta is dropped, because there is no longer an account
    // to push it to.
    state.dirty.clear();
    state.removed.clear();
    applySession(null);
    toast('Signed out. Your cards stay on this device.');
  }

  function applySession(session) {
    state.signedIn = !!session;
    state.email = session && session.user ? session.user.email || '' : '';
    // The account is worth showing, but on the control that acts on it rather
    // than as a line of prose under the cards.
    el.authBtn.setAttribute('aria-label',
      state.signedIn ? 'Sign out (' + state.email + ')' : 'Sign in to manage and sync your cards');
    el.authBtn.title = state.signedIn
      ? 'Signed in as ' + state.email
      : 'Sign in to manage and sync your cards';
    if (!state.signedIn) setPill('idle', 'Local');
    render();
  }

  /* ── theme ────────────────────────────────────────────── */

  /* Three states, not two. The old build hardcoded dark on <html> and never
     consulted the OS at all, so anyone on a light desktop got dark until they
     found the toggle. `system` is the default and the stylesheet handles it;
     an explicit choice writes data-theme and wins in both directions. */

  const THEME_ORDER = ['system', 'light', 'dark'];
  const THEME_LABEL = { system: 'follow system', light: 'light', dark: 'dark' };
  const THEME_ICON  = { system: 'ui-system', light: 'ui-sun', dark: 'ui-moon' };

  function applyTheme(theme) {
    state.theme = THEME_ORDER.indexOf(theme) >= 0 ? theme : 'system';
    const root = document.documentElement;
    if (state.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', state.theme);

    writeLocal(LS.theme, state.theme);
    el.themeIcon.setAttribute('href', '#hut-' + THEME_ICON[state.theme]);
    const next = THEME_ORDER[(THEME_ORDER.indexOf(state.theme) + 1) % THEME_ORDER.length];
    el.themeBtn.setAttribute('aria-label',
      'Theme: ' + THEME_LABEL[state.theme] + '. Switch to ' + THEME_LABEL[next] + '.');
  }

  function cycleTheme() {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(state.theme) + 1) % THEME_ORDER.length];
    applyTheme(next);
    toast('Theme: ' + THEME_LABEL[next] + '.');
  }

  /* ── wiring ───────────────────────────────────────────── */

  el.addBtn.addEventListener('click', () => openToolDialog(null));
  el.emptyAdd.addEventListener('click', () => openToolDialog(null));
  el.searchBtn.addEventListener('click', openPalette);
  el.themeBtn.addEventListener('click', cycleTheme);

  el.authBtn.addEventListener('click', async () => {
    if (!state.signedIn) { openAuthDialog(); return; }
    await signOut();
  });

  el.viewGrid.addEventListener('click', () => setView('grid'));
  el.viewList.addEventListener('click', () => setView('list'));
  el.orderManual.addEventListener('click', () => setOrder('manual'));
  el.orderFrecency.addEventListener('click', () => setOrder('frecency'));

  el.paletteInput.addEventListener('input', refreshPalette);
  el.paletteInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); movePalette(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); movePalette(-1); }
    else if (event.key === 'Home') { event.preventDefault(); state.palette.index = 0; renderPalette(); }
    else if (event.key === 'End') { event.preventDefault(); state.palette.index = Math.max(0, state.palette.items.length - 1); renderPalette(); }
    else if (event.key === 'Enter') { event.preventDefault(); choosePalette(state.palette.index); }
  });
  // Escape and backdrop dismissal both go through the native dialog, so keep
  // our own flag in step with it however it was closed.
  el.paletteDialog.addEventListener('close', () => { state.palette.open = false; });
  el.paletteDialog.addEventListener('click', (event) => {
    if (event.target === el.paletteDialog) closePalette();
  });

  document.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === 'k') {
      event.preventDefault();
      state.palette.open ? closePalette() : openPalette();
      return;
    }
    // A bare "/" opens search too, but only when the user is not already
    // typing into something.
    if (key === '/' && !state.palette.open && !isTyping(event.target)) {
      event.preventDefault();
      openPalette();
    }
  });

  function isTyping(node) {
    if (!node) return false;
    const tag = node.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
  }

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
  el.tabEmoji.addEventListener('click', () => { setIconTab('emoji', false); paintPicks(); });
  el.tabSvg.addEventListener('click', () => { setIconTab('svg', false); paintPicks(); });
  el.tabEmoji.addEventListener('keydown', onTabKey);
  el.tabSvg.addEventListener('keydown', onTabKey);

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
    // The shortcut hint has to match the keyboard actually in front of you.
    const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
    el.searchKbd.textContent = mac ? '⌘K' : 'Ctrl K';

    let storedTheme = 'system';
    try { storedTheme = localStorage.getItem(LS.theme) || 'system'; } catch (_) {}
    applyTheme(storedTheme);

    state.usage = readJson(LS.usage, {});
    let storedView = 'grid', storedOrder = 'manual';
    try {
      storedView = localStorage.getItem(LS.view) || 'grid';
      storedOrder = localStorage.getItem(LS.order) || 'manual';
    } catch (_) {}

    // Paint before touching the network: cache first, constants if there is no
    // cache. The wall is usable and launchable before Supabase answers.
    state.tools = cacheRead() || DEFAULT_TOOLS.map(tool => ({ ...tool }));

    // Each of these renders once; the last one is the paint that counts.
    setView(storedView);
    setOrder(storedOrder);

    if (!cloud.configured()) {
      // The pill is the whole status surface. In a deployed build this branch
      // is unreachable: the workflow fails if the placeholders survive.
      setPill('idle', 'Local only');
      el.pill.title = 'No database is configured for this deployment, so the wall ' +
                      'is read-only here. Your cards still launch, and anything ' +
                      'saved on this device stays on it.';
      el.authBtn.hidden = true;
      el.addBtn.hidden = true;
      el.emptyAdd.hidden = true;
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
    openPalette,
    setView,
    setOrder,
    DEFAULT_TOOLS
  };
})();
