/**
 * Stream an arbitrarily large, in-browser-generated file to disk via the
 * browser's own download manager, without buffering it in memory first.
 *
 * This is a standalone (framework-free, build-step-free) port of the same
 * module from the Ente web monorepo (`packages/gallery/services/
 * stream-download.ts`), for a static test page hosted on GitHub Pages — see
 * this repo's README for why this exists and what it's testing.
 *
 * The browser gives pages no direct filesystem access, but a service worker
 * can answer a `fetch` with a `ReadableStream` response body of unbounded
 * size. Either a navigation (a hidden iframe) or a plain resource fetch (a
 * hidden `<a download>` click), pointed at a URL inside the worker's scope,
 * triggers that fetch and the browser downloads the (streamed) response as
 * it would any other file. This module is the page-side half of that
 * protocol; `download-sw.js` is the worker-side half.
 *
 * The trigger mechanism has to differ by engine, each for a different,
 * confirmed reason:
 * - WebKit (Safari, all iOS browsers) does not route a plain `<a download>`
 *   click's fetch through the service worker's `fetch` handler at all —
 *   confirmed by it instead hitting the real network and downloading
 *   whatever a plain GET to that URL returns (e.g. a 404 page). WebKit's own
 *   service worker download tests always use a *navigation* to trigger this.
 *   A hidden iframe navigation gets the same navigation-type request
 *   WebKit's conversion logic is built around, with any failure contained
 *   to the invisible iframe rather than the real page.
 * - Android Chrome (and other Chromium-for-Android browsers) hands an
 *   `<a download>` click off to the Android OS's own system DownloadManager,
 *   which fetches the URL entirely outside the page's network stack — the
 *   request never reaches this worker at all, and fails outright. A
 *   navigation stays in-page instead, same fix as WebKit, unrelated reason.
 * - Firefox hands a `Content-Disposition: attachment` response to a
 *   *navigation* request off to a separate internal download-handling path,
 *   which re-fetches the same URL instead of reusing the already-streamed
 *   response — and that second request 404s, since our worker has
 *   (correctly) already forgotten the one-time-use id by then. So Firefox
 *   needs the opposite of WebKit/Android: a plain `<a download>` click, a
 *   resource fetch rather than a navigation.
 * - Desktop Chromium works fine with either; it uses the `<a download>`
 *   path since that's the default for everyone not covered above.
 *
 * Browsers also differ in how aggressively they terminate a service worker
 * they consider idle (observed as low as ~30s of no incoming event on
 * desktop Firefox, see https://github.com/jimmywarting/StreamSaver.js/issues/366),
 * which can truncate a slow download mid-stream. To avoid this we send a
 * "ping" message to the worker at a fixed interval for as long as the
 * download runs; receiving any message resets the worker's idle timer even
 * though the message itself carries no data.
 *
 * Known exception (confirmed, not fixed by this module): Firefox for
 * Android (GeckoView/Fenix) applies its own independent ~30s read timeout
 * to the response body stream itself, separate from the service worker's
 * idle timeout above — no ping can reset it, since it lives in a different
 * layer of the stack the page has no API to reach. On that browser, the
 * underlying data source must never stall more than ~20-25s, full stop.
 */

const SW_PATH = "download-sw.js";
const SW_SCOPE = "__download/";
const DEFAULT_PING_INTERVAL_MS = 10_000;

/**
 * Thrown when streaming a download is not possible in the current browser
 * or tab (e.g. no service worker support, a registration failure in private
 * browsing). Callers should fall back to an in-memory download on this
 * error.
 */
export class StreamDownloadUnavailable extends Error {}

let registrationPromise;

const waitForActivation = (worker) =>
    new Promise((resolve, reject) => {
        if (worker.state == "activated") {
            resolve();
            return;
        }
        worker.addEventListener("statechange", () => {
            if (worker.state == "activated") resolve();
            else if (worker.state == "redundant")
                reject(
                    new Error(
                        "The download service worker was discarded before activating",
                    ),
                );
        });
    });

const ensureServiceWorker = () =>
    (registrationPromise ??= (async () => {
        const registration = await navigator.serviceWorker.register(SW_PATH, {
            scope: SW_SCOPE,
        });
        // Nudge an update check now instead of relying on the browser's own
        // timing for it: an already-registered worker for this scope can
        // otherwise keep serving an older script version for longer than
        // expected, since browsers don't always re-check a registered
        // worker's script on every `register()` call.
        try {
            await registration.update();
        } catch {
            // Non-fatal (e.g. offline); fall through to whatever is there.
        }
        const worker =
            registration.installing ??
            registration.waiting ??
            registration.active;
        if (!worker)
            throw new Error("Service worker registration has no worker");
        if (worker.state != "activated") await waitForActivation(worker);
        return registration;
    })().catch((e) => {
        // Let the next call retry instead of permanently caching a failure.
        registrationPromise = undefined;
        throw e;
    }));

/**
 * `true` for Safari and all iOS browsers (which Apple requires to embed
 * WebKit regardless of their own branding, e.g. Chrome on iOS identifies
 * itself with a "CriOS" token but still runs on WebKit), `false` for
 * everything else.
 *
 * Chromium and Firefox browsers also carry an "AppleWebKit" token in their
 * user agent string for legacy compatibility even though their actual
 * engine is Blink or Gecko, so this isn't a simple substring check — it's
 * WebKit only if none of those *other* engines' own desktop/Android
 * identifying tokens are present. Their iOS-specific tokens (CriOS, FxiOS,
 * EdgiOS, OPiOS) are deliberately not excluded here, since those apps are
 * genuinely WebKit under the hood.
 */
export const isWebKitEngine = (userAgent) => {
    const ua = userAgent.toLowerCase();
    if (!ua.includes("applewebkit")) return false;
    return !/chrome|chromium|firefox|edg\/|opr\//.test(ua);
};

/**
 * `true` for Chromium-based browsers running on Android.
 *
 * Confirmed by testing: unlike desktop Chromium, Android Chrome hands an
 * `<a download>` click's request off to the Android OS's own system
 * DownloadManager, which fetches the URL entirely outside the page's (and
 * so the service worker's) network stack. Android Firefox is deliberately
 * not included here: the download-manager handoff is a Chrome-for-Android
 * characteristic, not a general "mobile" one, and Firefox (any platform)
 * needs the opposite trigger for its own, unrelated reason.
 */
export const isAndroidChromium = (userAgent) => {
    const ua = userAgent.toLowerCase();
    return ua.includes("android") && !ua.includes("firefox");
};

/**
 * Stream {@link body} to disk as a download named {@link fileName}.
 *
 * The returned promise resolves once every byte of {@link body} has been
 * handed off to the service worker (which is as much of the save as
 * JavaScript can observe; the browser then finishes writing it to disk on
 * its own). It rejects if {@link signal} is aborted, if the browser's
 * download UI is cancelled by the user, if reading {@link body} fails, or
 * with a {@link StreamDownloadUnavailable} if the worker itself could not be
 * set up.
 *
 * @param {string} fileName
 * @param {ReadableStream<Uint8Array>} body
 * @param {AbortSignal} signal
 * @param {{ pingIntervalMs?: number }} [opts]
 * @returns {Promise<void>}
 */
export const streamDownload = async (fileName, body, signal, opts) => {
    if (signal.aborted)
        throw new DOMException("Download was cancelled", "AbortError");

    let registration;
    try {
        registration = await ensureServiceWorker();
    } catch (e) {
        throw new StreamDownloadUnavailable(
            "Could not set up the download service worker",
            { cause: e },
        );
    }

    const worker = registration.active;
    if (!worker)
        throw new StreamDownloadUnavailable("Service worker is not active");

    if (signal.aborted)
        throw new DOMException("Download was cancelled", "AbortError");

    const id = crypto.randomUUID();
    const channel = new MessageChannel();
    const reader = body.getReader();

    const cleanups = [];
    const cleanup = () => cleanups.splice(0).forEach((fn) => fn());

    await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn) => {
            if (settled) return;
            settled = true;
            fn();
        };

        const readyTimerBox = {};

        channel.port1.onmessage = (event) => {
            const msg = event.data;
            if (msg?.type == "ready") {
                // Only safe to trigger the fetch once the worker confirms
                // it has recorded `id`: the "start" message and the
                // trigger's fetch are independent, unordered event
                // dispatches, and the fetch reaching the worker before
                // "start" is processed is a real race, not a theoretical
                // one (it 404s when it happens, since the worker then has
                // nothing recorded for `id` and lets the request fall
                // through to the network).
                clearTimeout(readyTimerBox.current);
                const url = new URL(
                    SW_SCOPE + id,
                    registration.active.scriptURL,
                ).href;
                if (
                    isWebKitEngine(navigator.userAgent) ||
                    isAndroidChromium(navigator.userAgent)
                ) {
                    const iframe = document.createElement("iframe");
                    iframe.hidden = true;
                    iframe.src = url;
                    document.body.appendChild(iframe);
                    cleanups.push(() => iframe.remove());
                } else {
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = fileName;
                    link.hidden = true;
                    document.body.appendChild(link);
                    link.click();
                    cleanups.push(() => link.remove());
                }
            } else if (msg?.type == "pull") {
                reader
                    .read()
                    .then(({ done, value }) => {
                        if (done) {
                            channel.port1.postMessage({ done: true });
                            settle(resolve);
                        } else {
                            channel.port1.postMessage({ chunk: value }, [
                                value.buffer,
                            ]);
                        }
                    })
                    .catch((e) => {
                        channel.port1.postMessage({
                            error: e instanceof Error ? e.message : String(e),
                        });
                        settle(() =>
                            reject(
                                e instanceof Error ? e : new Error(String(e)),
                            ),
                        );
                    });
            } else if (msg?.type == "cancel") {
                void reader.cancel().catch(() => undefined);
                settle(() =>
                    reject(
                        new DOMException(
                            "Download was cancelled",
                            "AbortError",
                        ),
                    ),
                );
            }
        };

        worker.postMessage({ type: "start", id, fileName }, [channel.port2]);
        readyTimerBox.current = setTimeout(() => {
            settle(() =>
                reject(
                    new StreamDownloadUnavailable(
                        "The download service worker did not acknowledge the download in time",
                    ),
                ),
            );
        }, 5_000);
        cleanups.push(() => clearTimeout(readyTimerBox.current));

        const pingIntervalMs = opts?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
        if (pingIntervalMs > 0) {
            const pingTimer = setInterval(
                () => worker.postMessage({ type: "ping" }),
                pingIntervalMs,
            );
            cleanups.push(() => clearInterval(pingTimer));
        }

        const onAbort = () => {
            void reader.cancel().catch(() => undefined);
            settle(() =>
                reject(
                    new DOMException("Download was cancelled", "AbortError"),
                ),
            );
        };
        signal.addEventListener("abort", onAbort);
        cleanups.push(() => signal.removeEventListener("abort", onAbort));

        const beforeUnload = (e) => {
            e.preventDefault();
        };
        window.addEventListener("beforeunload", beforeUnload);
        cleanups.push(() =>
            window.removeEventListener("beforeunload", beforeUnload),
        );
    }).finally(cleanup);
};
