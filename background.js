// Xmate background service worker
//
// Lists everyone you follow via X's STABLE v1.1 endpoint:
//   GET https://api.x.com/1.1/friends/list.json?user_id=<you>&count=200&include_ext_is_blue_verified=1
//
// Why v1.1 and not GraphQL:
//   * fixed URL — no rotating queryId, so there is NOTHING to calibrate.
//   * each user object already includes `status` (their last tweet → "Last Active"),
//     `followed_by` (follows-you), counts, created date, verified. No per-user calls.
//   * 200 users per page → ~5 requests for ~1k following (limit is 15 / 15 min).
//
// Auth: the well-known public web Bearer + your `ct0` cookie (sent automatically with
// credentials:"include"). We also passively capture a fresher Bearer/csrf from your own
// x.com traffic, used as an override if present — but nothing here requires that capture.

// Public x.com web app Bearer (static for years). Overridden by a live-captured token if seen.
const PUBLIC_BEARER =
  "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const API_HOST_FILTER = {
  urls: ["*://x.com/i/api/*", "*://api.x.com/*", "*://twitter.com/i/api/*", "*://api.twitter.com/*"]
};

const store = {
  get: (k) => chrome.storage.local.get(k).then((o) => o[k]),
  set: (k, v) => chrome.storage.local.set({ [k]: v })
};

// ---------- passively capture a fresh Bearer + csrf (optional override) ----------
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const h = details.requestHeaders || [];
    const auth = h.find((x) => x.name.toLowerCase() === "authorization");
    const csrf = h.find((x) => x.name.toLowerCase() === "x-csrf-token");
    if (auth && auth.value && csrf && csrf.value) {
      store.set("auth", { authorization: auth.value, csrf: csrf.value, ts: Date.now() });
    }
  },
  API_HOST_FILTER,
  ["requestHeaders", "extraHeaders"]
);

// ---------- cookies ----------
async function getCookie(name) {
  for (const url of ["https://x.com", "https://twitter.com"]) {
    const c = await chrome.cookies.get({ url, name });
    if (c && c.value) return c.value;
  }
  return null;
}
async function getOwnUserId() {
  const twid = await getCookie("twid"); // u%3D<userId>
  if (!twid) return null;
  const m = decodeURIComponent(twid).match(/u=(\d+)/);
  return m ? m[1] : null;
}

async function buildHeaders() {
  const auth = await store.get("auth");
  const ct0 = (await getCookie("ct0")) || (auth && auth.csrf);
  if (!ct0) return null; // not logged in
  return {
    authorization: (auth && auth.authorization) || PUBLIC_BEARER,
    "x-csrf-token": ct0,
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    "content-type": "application/json",
    accept: "*/*"
  };
}

// ---------- map a v1.1 user object to our shape ----------
const numOr = (v) => (typeof v === "number" ? v : null);
function parseUser(u) {
  if (!u || !u.screen_name) return null;
  const status = u.status || {};
  return {
    id: u.id_str || (u.id != null ? String(u.id) : u.screen_name),
    handle: u.screen_name,
    name: u.name || u.screen_name,
    avatar: (u.profile_image_url_https || "").replace("_normal", "_bigger"),
    bio: u.description || "",
    verified: !!(u.ext_is_blue_verified || u.is_blue_verified || u.verified),
    followsYou: !!u.followed_by,
    following: numOr(u.friends_count),
    followers: numOr(u.followers_count),
    tweets: numOr(u.statuses_count),
    likes: numOr(u.favourites_count),
    createdAt: u.created_at || null,
    lastActive: status.created_at || null,        // last tweet date — included in the response
    lastTweet: status.full_text || status.text || ""
  };
}

// ---------- fetch one page of friends/list ----------
async function fetchFriendsPage(cursor) {
  const headers = await buildHeaders();
  const userId = await getOwnUserId();
  if (!headers)
    return { error: { code: "noauth", detail: "Couldn't read your X session. Open x.com (logged in) in another tab, then retry." } };
  if (!userId)
    return { error: { code: "nouser", detail: "Couldn't determine your X account. Make sure you're logged in to x.com." } };

  let url = `https://api.x.com/1.1/friends/list.json?user_id=${userId}&count=200&skip_status=false&include_ext_is_blue_verified=1&include_user_entities=false`;
  if (cursor && cursor !== "0") url += `&cursor=${encodeURIComponent(cursor)}`;

  try {
    const res = await fetch(url, { headers, credentials: "include", method: "GET" });
    if (res.status === 429)
      return { error: { code: "ratelimit", detail: "X rate-limited friends/list (15 requests / 15 min). Wait a couple minutes, then Load more." } };
    if (!res.ok) {
      let body = "";
      try { body = (await res.text()).slice(0, 400); } catch (_) {}
      console.error("[Xmate] friends/list HTTP", res.status, body);
      return { error: { code: "http", detail: `X returned ${res.status}. ${body || "Your session may have expired — reload x.com and retry."}` } };
    }
    const json = await res.json();
    const users = (json.users || []).map(parseUser).filter(Boolean);
    let next = json.next_cursor_str;
    if (next == null && json.next_cursor != null) next = String(json.next_cursor);
    return { users, nextCursor: next && next !== "0" ? next : null };
  } catch (err) {
    return { error: { code: "exception", detail: String(err && err.message ? err.message : err) } };
  }
}

// ---------- messaging ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "status") {
    Promise.all([getCookie("ct0"), getOwnUserId()]).then(([ct0, userId]) =>
      sendResponse({ hasSession: !!(ct0 && userId) })
    );
    return true;
  }
  if (msg.action === "fetchPage") {
    fetchFriendsPage(msg.cursor || null).then(sendResponse);
    return true;
  }
  if (msg.action === "openTab") {
    chrome.tabs.create({ url: chrome.runtime.getURL("tab/following.html") });
  }
});
