# Xmate — Following Manager

A private, read-only Chrome extension (Manifest V3, vanilla JS, no build step) that lists everyone
you follow on X with full stats: **last active, followers, following, tweets, account age, verified,
and whether they follow you back.** Click any card to open that profile on X. No unfollowing, no
scheduling, no data leaves your browser.

## How it works

It uses X's **stable v1.1 endpoint** with your logged-in session — no setup, nothing to calibrate:

```
GET https://api.x.com/1.1/friends/list.json?user_id=<you>&count=200&skip_status=false&include_ext_is_blue_verified=1
```

1. The background worker reads your `ct0` cookie (CSRF token) and your user id from the `twid` cookie,
   and authenticates with X's public web Bearer token + `credentials:"include"` (so your session
   cookies ride along). A `webRequest` listener also captures a fresher Bearer from your own x.com
   traffic as an optional override, but it isn't required.
2. It pages through `friends/list.json` (200 per request, cursor-based) until your whole following
   list is loaded — about 5 requests for ~1k accounts, well under X's ~15-per-15-min limit. A 350ms
   gap separates requests; if a very large account ever gets rate-limited mid-load, it keeps what it
   has and **Load more** resumes the rest.
3. **Every stat comes from that one response** — including "Last Active" (each user's last tweet date,
   in the `status` field). No per-user calls.
4. Results are cached in `chrome.storage.local`, so reopening is instant. Hit **Refresh** to re-fetch.

Because the endpoint URL is fixed (unlike X's rotating GraphQL query IDs), there's no calibration step
and nothing to break when X changes its web app.

## Install (load unpacked)

1. Go to `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select this `xmate` folder.
4. Make sure you're logged in to **x.com**.
5. Click the Xmate toolbar icon → **Open Following Manager** → **Find Following**. That's it.

## Using it

- **Find Following** loads your entire following list (watch the count climb); **Refresh** re-fetches.
- **Load more** reveals the next 45 rows (display-only — the full list is already loaded, so it's instant).
- **Search** by name, @handle, or bio.
- **Sort** by followers, following, last active, created date, tweets, or follow ratio (High↔Low).
- **Filter chips:** *Doesn't follow back*, *Follows you*, *Verified*, *Unverified*
  (Verified/Unverified and Follows-you/Doesn't-follow-back are mutually exclusive).

## Files

```
manifest.json        MV3 manifest (permissions: storage, cookies, webRequest)
background.js        friends/list.json fetch + pagination + auth
popup.html / .js     toolbar popup → opens the manager
tab/following.html   the manager UI
tab/following.css    styles (solid blue accent, no gradients)
tab/following.js     load/render/filter/sort/cache + Load more
icons/               toolbar icons
```

## Privacy

Everything runs locally in your browser using your existing X session. No external servers,
no analytics, no account required.

## License

[MIT](LICENSE) © 2026 Venelin Kochev

Xmate is an independent project and is not affiliated with, endorsed by, or sponsored by X Corp.
