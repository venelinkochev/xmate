"use strict";

const $ = (id) => document.getElementById(id);
const send = (action, extra) =>
  new Promise((res) => chrome.runtime.sendMessage({ action, ...(extra || {}) }, (r) => res(r)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_SIZE = 45; // display batch ("Load more" reveals this many)

const state = {
  users: [],          // accumulated from the API
  loadedIds: new Set(),
  cursor: null,       // friends/list next_cursor (null once exhausted)
  done: false,
  loading: false,
  shown: PAGE_SIZE,   // how many filtered rows are currently displayed
  fetchedAt: null,
  search: "",
  sortBy: "none",
  order: "desc",
  filters: { nonfollowers: false, followsyou: false, verified: false, unverified: false }
};

// ---------- formatting ----------
const nf = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const fmt = (n) => (typeof n === "number" ? nf.format(n) : "—");
function year(s) {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(d) ? "—" : String(d.getFullYear());
}
function timeAgo(s) {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d)) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return { label: "Today", fresh: true };
  if (days === 1) return { label: "Yesterday", fresh: true };
  if (days < 7) return { label: `${days}d ago`, fresh: true };
  if (days < 30) return { label: `${Math.floor(days / 7)}w ago`, fresh: days < 21 };
  if (days < 365) return { label: `${Math.floor(days / 30)}mo ago`, fresh: false };
  return { label: `${Math.floor(days / 365)}y ago`, fresh: false };
}
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const VERIFIED_SVG =
  '<svg class="badge" viewBox="0 0 24 24" fill="currentColor"><path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z"/></svg>';

// ---------- filtering / sorting ----------
function applyFilters() {
  const q = state.search.trim().toLowerCase();
  let list = state.users.filter((u) => {
    if (state.filters.nonfollowers && u.followsYou) return false;
    if (state.filters.followsyou && !u.followsYou) return false;
    if (state.filters.verified && !u.verified) return false;
    if (state.filters.unverified && u.verified) return false;
    if (q && !`${u.name} ${u.handle} ${u.bio}`.toLowerCase().includes(q)) return false;
    return true;
  });
  if (state.sortBy !== "none") {
    const key = state.sortBy;
    const val = (u) => {
      if (key === "lastActive" || key === "createdAt") {
        const t = Date.parse(u[key]);
        return isNaN(t) ? -Infinity : t;
      }
      if (key === "ratio") return (u.followers || 0) / Math.max(u.following || 0, 1);
      return typeof u[key] === "number" ? u[key] : -Infinity;
    };
    const dir = state.order === "asc" ? 1 : -1;
    list = [...list].sort((a, b) => (val(a) - val(b)) * dir);
  }
  return list;
}

// ---------- rendering ----------
function card(u) {
  const t = timeAgo(u.lastActive);
  const activeTag = t
    ? `<span class="tag ${t.fresh ? "live" : "stale"}">Active <b>${t.label}</b></span>`
    : `<span class="tag">Active <b>—</b></span>`;
  return `
  <a class="user" href="https://x.com/${encodeURIComponent(u.handle)}" target="_blank" rel="noopener">
    <div class="top">
      <img src="${escapeHtml(u.avatar)}" loading="lazy" alt="" onerror="this.style.visibility='hidden'"/>
      <div class="id">
        <div class="name"><span>${escapeHtml(u.name)}</span>${u.verified ? VERIFIED_SVG : ""}
          ${u.followsYou ? '<span class="followsyou">Follows you</span>' : ""}
        </div>
        <div class="handle">@${escapeHtml(u.handle)}</div>
      </div>
    </div>
    <div class="bio">${escapeHtml(u.bio)}</div>
    <div class="counts">
      <div><b>${fmt(u.following)}</b><span class="lbl">Following</span></div>
      <div><b>${fmt(u.followers)}</b><span class="lbl">Followers</span></div>
      <div><b>${fmt(u.tweets)}</b><span class="lbl">Tweets</span></div>
    </div>
    <div class="meta">
      ${activeTag}
      <span class="tag">Joined <b>${year(u.createdAt)}</b></span>
    </div>
  </a>`;
}

function render() {
  const list = applyFilters();
  const grid = $("grid");
  const empty = $("empty");

  if (!state.users.length) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    empty.innerHTML = state.loading
      ? `<div class="big">⏳</div>Loading…`
      : `<div class="big">👀</div>Click <b>Find Following</b> to load the people you follow.`;
    $("resultMeta").classList.add("hidden");
    updateLoadMore(0, 0);
    return;
  }

  const shown = Math.min(state.shown, list.length);
  if (!list.length) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    empty.innerHTML = `<div class="big">🔍</div>No accounts match your filters.`;
  } else {
    empty.classList.add("hidden");
    grid.innerHTML = list.slice(0, shown).map(card).join("");
  }

  const meta = $("resultMeta");
  meta.classList.remove("hidden");
  const when = state.fetchedAt ? new Date(state.fetchedAt).toLocaleString() : "";
  const totalNote = state.done ? `${state.users.length.toLocaleString()} total` : `${state.users.length.toLocaleString()} loaded · more available`;
  meta.textContent = `Showing ${shown.toLocaleString()} of ${list.length.toLocaleString()} (${totalNote}) · fetched ${when}`;

  updateLoadMore(shown, list.length);
}

function updateLoadMore(shown, filteredCount) {
  const btn = $("loadMore");
  const moreToShow = filteredCount > shown;
  const moreOnServer = !state.done;
  if (state.users.length && (moreToShow || moreOnServer)) {
    btn.classList.remove("hidden");
    btn.disabled = state.loading;
    btn.textContent = state.loading ? "Loading…" : `Load ${PAGE_SIZE} more`;
  } else {
    btn.classList.add("hidden");
  }
}

function renderHero() {
  const total = state.users.length;
  if (!total) {
    $("heroStats").innerHTML = "";
    return;
  }
  const followsYou = state.users.filter((u) => u.followsYou).length;
  const label = state.done ? "Following" : "Loaded";
  $("heroStats").innerHTML = `
    <div class="stat"><div class="n">${total.toLocaleString()}</div><div class="l">${label}</div></div>
    <div class="stat"><div class="n">${followsYou.toLocaleString()}</div><div class="l">Follow back</div></div>
    <div class="stat"><div class="n">${(total - followsYou).toLocaleString()}</div><div class="l">Don't</div></div>`;
}

// ---------- loading ----------
async function fetchNextPage() {
  if (state.done) return false;
  const resp = await send("fetchPage", { cursor: state.cursor }).catch(() => null);
  if (!resp || resp.error) {
    handleError(resp && resp.error);
    return false;
  }
  const fresh = (resp.users || []).filter((u) => !state.loadedIds.has(u.id));
  for (const u of fresh) {
    state.loadedIds.add(u.id);
    state.users.push(u);
  }
  state.cursor = resp.nextCursor || null;
  state.done = !state.cursor || fresh.length === 0;
  state.fetchedAt = Date.now();
  saveCache();
  return true;
}

async function loadFromStart() {
  if (state.loading) return;
  hideBanner();
  state.loading = true;
  updateButtons();
  if (!state.users.length) render(); // show "Loading…" only when there's nothing yet

  // Fetch the first page BEFORE clearing, so a failed refresh keeps the old list.
  const resp = await send("fetchPage", { cursor: null }).catch(() => null);
  if (!resp || resp.error) {
    state.loading = false;
    handleError(resp && resp.error);
    updateButtons();
    return;
  }

  state.users = resp.users || [];
  state.loadedIds = new Set(state.users.map((u) => u.id));
  state.cursor = resp.nextCursor || null;
  state.done = !state.cursor || state.users.length === 0;
  state.shown = PAGE_SIZE;
  state.fetchedAt = Date.now();
  saveCache();
  renderHero();
  render();
  showProgress(`Loaded ${state.users.length}…`);

  // Fetch ALL remaining pages now (≈5 requests for ~1k follows), gently.
  while (!state.done) {
    await sleep(350);
    const ok = await fetchNextPage(); // appends; on error/429 keeps what we have + keeps cursor to resume
    showProgress(`Loaded ${state.users.length}…`);
    renderHero();
    render();
    if (!ok) break;
  }

  state.loading = false;
  hideProgress();
  saveCache();
  renderHero();
  render();
  updateButtons();
}

// "Load more" is now display-only — just reveal the next batch. (If a huge account got
// cut short by a rate limit it can still resume fetching the remainder.)
async function loadMore() {
  state.shown += PAGE_SIZE;
  if (!state.loading && !state.done && state.users.length < state.shown) {
    state.loading = true;
    updateButtons();
    showProgress("Loading more…");
    while (!state.done && state.users.length < state.shown) {
      const ok = await fetchNextPage();
      if (!ok) break;
      await sleep(350);
    }
    state.loading = false;
    hideProgress();
    renderHero();
    updateButtons();
  }
  render();
}

function updateButtons() {
  const btn = $("fetchBtn");
  btn.disabled = state.loading;
  btn.textContent = state.loading ? "Loading…" : state.users.length ? "Refresh" : "Find Following";
}

// ---------- progress / banners ----------
function showProgress(text) {
  $("progress").classList.remove("hidden");
  $("progressText").textContent = text;
}
function hideProgress() { $("progress").classList.add("hidden"); }
function banner(html, isError) {
  const b = $("banner");
  b.className = "banner" + (isError ? " error" : "");
  b.innerHTML = html;
  b.classList.remove("hidden");
}
function hideBanner() { $("banner").classList.add("hidden"); }
function handleError(err) {
  banner(`<b>Couldn't load.</b> ${escapeHtml((err && err.detail) || "Unknown error.")}`, true);
}

// ---------- cache ----------
function saveCache() {
  chrome.storage.local.set({
    followingCache: { users: state.users, cursor: state.cursor, done: state.done, fetchedAt: state.fetchedAt }
  });
}

// ---------- wire up ----------
$("fetchBtn").addEventListener("click", loadFromStart);
$("loadMore").addEventListener("click", loadMore);
$("search").addEventListener("input", (e) => { state.search = e.target.value; state.shown = PAGE_SIZE; render(); });
$("sortBy").addEventListener("change", (e) => { state.sortBy = e.target.value; state.shown = PAGE_SIZE; render(); });
$("order").addEventListener("change", (e) => { state.order = e.target.value; state.shown = PAGE_SIZE; render(); });

const EXCLUSIVE = { verified: "unverified", unverified: "verified", followsyou: "nonfollowers", nonfollowers: "followsyou" };
document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const f = chip.dataset.filter;
    state.filters[f] = !state.filters[f];
    if (state.filters[f] && EXCLUSIVE[f]) {
      state.filters[EXCLUSIVE[f]] = false;
      const other = document.querySelector(`.chip[data-filter="${EXCLUSIVE[f]}"]`);
      if (other) other.classList.remove("active");
    }
    chip.classList.toggle("active", state.filters[f]);
    state.shown = PAGE_SIZE;
    render();
  });
});

// ---------- boot ----------
(async function boot() {
  const { followingCache } = await chrome.storage.local.get("followingCache");
  if (followingCache && Array.isArray(followingCache.users)) {
    state.users = followingCache.users;
    state.cursor = followingCache.cursor || null;
    state.done = !!followingCache.done;
    state.fetchedAt = followingCache.fetchedAt || null;
    state.loadedIds = new Set(state.users.map((u) => u.id));
  }

  const s = await send("status");
  if (s && !s.hasSession) {
    banner(`<b>Log in to X first.</b> Open <a href="https://x.com" target="_blank">x.com</a> and sign in, then click Find Following.`, true);
  }

  renderHero();
  render();
  updateButtons();
})();
