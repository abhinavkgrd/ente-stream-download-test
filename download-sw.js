// Streams a single large download (e.g. a ZIP archive assembled in the
// page) through the browser's normal download manager.
//
// The page cannot write directly to the user's filesystem, but a service
// worker can synthesize a `fetch` response with a `ReadableStream` body of
// unbounded size. Either a hidden iframe navigation or a hidden `<a
// download>` click, pointed at a URL within this worker's scope, triggers
// that fetch; the browser then saves the response as a download, pulling
// bytes from the page (which has the data, e.g. decrypted file contents)
// over a MessageChannel as the archive is built.
//
// Which trigger to use is decided on the page side (`stream-download.js`),
// per engine, for three separate, confirmed reasons:
// - WebKit (Safari, all iOS browsers) doesn't route a plain `<a download>`
//   click through this worker's `fetch` handler at all — confirmed by it
//   instead hitting the real network for a plain GET. It needs a navigation
//   (an iframe, in this case) to be treated as a download candidate at all.
// - Android Chrome hands an `<a download>` click off to the Android OS's own
//   system DownloadManager, which fetches the URL entirely outside the
//   page's network stack, so it never reaches this worker either. Same fix
//   as WebKit (a navigation), different reason.
// - Firefox hands a `Content-Disposition: attachment` response to a
//   *navigation* request off to a separate download path that re-fetches
//   the URL instead of reusing the stream, which 404s against this worker's
//   one-time-use ids (since the id is deleted from `pendingDownloads` on
//   first match, below). It needs the opposite: a plain `<a download>`
//   click, not a navigation.
//
// This worker's own `fetch` handler doesn't need to know or care which
// trigger produced the request; both end up as a normal `fetch` event here.
//
// This file is intentionally framework-free plain JS: service workers run
// in their own global scope. Unlike the copy of this file in the Ente web
// monorepo, the scope-matching regex below is NOT anchored to the start of
// the path (`/__download/` vs this worker's own registration scope, which
// on a GitHub Pages project site is a subpath like
// `/ente-stream-download-test/__download/`, not the origin root) — this
// copy matches the id at the END of the path instead, so it works
// regardless of how deep the site is hosted.

/** @type {Map<string, { fileName: string, port: MessagePort }>} */
const pendingDownloads = new Map();

self.addEventListener("install", () => {
    // Activate immediately; this worker has no cached assets to version.
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.type === "start") {
        const port = event.ports[0];
        if (!port) return;
        pendingDownloads.set(data.id, { fileName: data.fileName, port });
        // Ack on the same port once the id is recorded, so the page knows it
        // is now safe to trigger the matching fetch below. Without this
        // handshake, the "start" message and the trigger's own fetch are
        // two independent, unordered event dispatches; the fetch can (and
        // in practice does) sometimes arrive here before "start" has been
        // processed, in which case `pending` is still unset and the request
        // wrongly falls through to the network.
        port.postMessage({ type: "ready" });
    }

    // A "ping" message needs no handling beyond having been received: any
    // incoming event resets the browser's idle timer for this worker, which
    // is what keeps it alive for the whole lifetime of a slow download
    // (otherwise an idle period of ~30s is enough for some browsers to
    // terminate the worker mid-stream, corrupting the download).
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    const match = /\/__download\/([^/]+)$/.exec(url.pathname);
    if (!match) return;

    const id = match[1];
    const pending = pendingDownloads.get(id);
    // One-time use: a reload or a retried request must not replay (or hang
    // on) an already-consumed id.
    pendingDownloads.delete(id);
    if (!pending) return;

    const { fileName, port } = pending;

    const body = new ReadableStream({
        pull(controller) {
            return new Promise((resolve) => {
                port.onmessage = (e) => {
                    const msg = e.data;
                    if (msg && msg.chunk) {
                        controller.enqueue(msg.chunk);
                    } else if (msg && msg.done) {
                        controller.close();
                    } else if (msg && msg.error) {
                        controller.error(new Error(msg.error));
                    }
                    resolve();
                };
                port.postMessage({ type: "pull" });
            });
        },
        cancel(reason) {
            port.postMessage({ type: "cancel", reason: String(reason) });
        },
    });

    const headers = new Headers({
        "Content-Type": "application/zip",
        "Content-Disposition":
            "attachment; filename*=UTF-8''" + encodeURIComponent(fileName),
        "X-Content-Type-Options": "nosniff",
    });

    event.respondWith(new Response(body, { headers }));
});
