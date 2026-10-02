# Stream download test

A standalone test page for [ente-io/ente#628](https://github.com/ente-io/ente/discussions/628)
(single-ZIP album downloads). Proves, per browser, whether a service worker
can stream an arbitrarily large file straight to the browser's download
manager — with no in-memory buffering of the whole file on either side — and
survive a slow/intermittent data producer without the download getting
silently killed or truncated.

**Live page**: https://abhinavkgrd.github.io/ente-stream-download-test/

No build step, no dependencies — open `index.html` directly (over HTTPS, or
via `localhost`/a local server; service workers need a secure context) or
just use the GitHub Pages link above.

## How it works

- `download-sw.js` — a service worker, scoped to `__download/`, that answers
  a `fetch` with a streamed `ReadableStream` response built from a
  pull-based protocol over a `MessageChannel`: the page feeds it bytes chunk
  by chunk as they're produced, the worker relays them straight into the
  response body, and the browser writes that to the downloaded file as it
  arrives.
- `stream-download.js` — the page-side half of that protocol. Picks a
  download *trigger* per browser engine (see below), and sends a periodic
  keep-alive ping to the worker to stop some browsers from treating it as
  idle and killing it mid-download.
- `app.js` / `index.html` — the actual test: generates a deterministic 128
  MiB synthetic payload (each 4 MiB chunk filled with a single repeated byte
  equal to its own index, so a truncated or corrupted file is trivially
  checkable) with artificial pauses injected to simulate a slow network/
  decrypt step, and reports chunk-by-chunk progress.
- `verify.mjs` — run against a downloaded file to confirm it's byte-exact,
  not just "a file appeared." **Don't trust the on-page status alone** — see
  the WebKit and Android findings below for why.

```
node verify.mjs ~/Downloads/stream-test-keepalive-<timestamp>.bin
```

## Results so far

| Browser | Status |
|---|---|
| Chromium desktop | ✅ works |
| Firefox desktop | ✅ works (with the keep-alive ping) |
| Safari macOS | ✅ works (with the iframe trigger) |
| Chrome Android | ✅ works (with the iframe trigger) |
| Firefox Android | ❌ platform limitation — see below |
| iOS Safari / iOS Chrome | not yet tested |
| Edge desktop | not yet tested |

All ✅ results above were byte-verified against the actual downloaded file,
not just the on-page "done" status.

## Bugs found along the way

**1. Firefox: service worker idle-timeout.** A long gap with no activity
(confirmed ~30s) is enough for Firefox to terminate the service worker
mid-stream, truncating the download — this is the known
[StreamSaver.js#366](https://github.com/jimmywarting/StreamSaver.js/issues/366)
issue. Fixed with the keep-alive ping: a plain `postMessage` to the worker
every 10s, carrying no data, purely to reset its idle timer.

**2. Firefox: attachment-navigation re-fetch.** Separately, Firefox hands a
`Content-Disposition: attachment` response to a *navigation* request (e.g.
an iframe) off to a separate internal download-handling path, which
re-fetches the same URL instead of reusing the already-streamed response.
That second request 404s, since the worker has (correctly) already
forgotten the one-time-use download id by then. Fixed by triggering the
download with a hidden `<a download>` click instead of an iframe — a plain
resource fetch, not a navigation, so it doesn't hit this path.

**3. Safari + Android Chrome: the opposite trigger problem.** A hidden
`<a download>` click doesn't route through the service worker's `fetch`
handler at all on these two:
- On **desktop Safari**, confirmed by reading the actual bytes of a
  "successful-looking" download — it was literally the test server's 404
  page, saved under the expected filename. WebKit hands the click to its own
  download-decision path as a plain network request, bypassing the worker
  entirely.
- On **Android Chrome**, confirmed via an OS-level "download failed"
  notification plus zero matching requests anywhere in DevTools' Network
  panel. Chrome hands the click to Android's own system DownloadManager,
  which fetches the URL entirely outside the page's network stack.

Fixed, for both, by using a hidden iframe navigation instead — the same
mechanism WebKit's own service-worker-download tests use, and which stays
within the page's own network stack on Android.

So the final trigger choice is picked per engine:
`isWebKitEngine(ua) || isAndroidChromium(ua)` → iframe; everyone else →
`<a download>` click.

## The one unresolved gap: Firefox for Android

Firefox for Android (Fenix) truncates at a fixed point regardless of the
keep-alive ping, confirmed even with the app kept fully in the foreground
for the whole run (ruling out a background-tab-reclaim explanation, unlike
the similar-looking issue initially suspected on Safari).

Root cause, read directly from current GeckoView/Fenix source: on Android,
Fenix streams the response through an extra layer desktop Firefox doesn't
have — GeckoView's `WebResponse`/`GeckoInputStream` — which applies its own
**independent ~30s read timeout** to the response body stream
(`WebResponse.DEFAULT_READ_TIMEOUT_MS = 30000`). This is a different timer
from the service worker's own idle timeout (which the keep-alive ping does
correctly reset); the ping has no path to reach this other, GeckoView-layer
timer, since there's no web-exposed API to touch it. When it fires, Fenix's
download service retries with a `Range`-header request against the same
URL, which can't succeed against a one-time-use id, so the file is
permanently stuck at whatever was already written.

Confirmed empirically on a real device with the "Firefox Android control"
section on the test page: a **25s** pause between chunks completes fine; a
**35s** pause truncates every time, at the identical byte offset — bracketing
the ~30s GeckoView default exactly.

**Practical implication**: this isn't fixable by pinging harder. The
constraint for this browser is that the actual data source must never stall
more than ~20-25s, which is a read-ahead/buffering design question for
whatever builds the real ZIP stream (prefetch the next file before the
current one finishes; fail-fast rather than hang on a stalled upstream
fetch), not something `stream-download.js` can paper over. Current plan:
leave Firefox Android on the existing (non-streamed) fallback until that's
addressed.

## Testing on a real mobile device

A plain `http://<LAN-IP>:port` URL will **not** work for this at all,
regardless of any of the above — Chrome only treats `localhost`/`127.0.0.1`
as a secure context by default, and service worker registration requires
one. The GitHub Pages link is HTTPS, so it works directly; for testing a
local change before pushing, tunnel a local dev server to the device instead
(e.g. `adb reverse tcp:PORT tcp:PORT` for Android over USB) rather than
using the machine's LAN IP.

Note: an `adb reverse` port forward is dropped whenever the device
reconnects (USB unplugged/replugged, sleep/wake in some cases) — if the
tunnel suddenly stops working mid-session, check `adb reverse --list`
(empty means dropped) before assuming something else broke.
