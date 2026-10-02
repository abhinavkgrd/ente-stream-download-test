// Phase 1 verification tool for ente-io/ente#628 (standalone version, see
// README.md). Proves (or disproves), per browser, that `streamDownload`
// survives multi-second idle gaps that would otherwise let the browser
// terminate the service worker mid-download, as reported in
// https://github.com/jimmywarting/StreamSaver.js/issues/366, and exercises
// the per-engine download-trigger fixes documented in stream-download.js.
import {
    streamDownload,
    StreamDownloadUnavailable,
} from "./stream-download.js";

// Keeping these modest (rather than a multi-GB/many-minute run) is
// deliberate: what StreamSaver#366 shows is broken by a long *idle gap*,
// not by total size, so a few minutes of repeated gaps over a download of a
// size convenient to eyeball is enough to settle the keep-alive question.
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB
const CHUNK_COUNT = 32; // 128 MiB total
const PAUSE_EVERY_N_CHUNKS = 8; // 3 pauses over the run
const DEFAULT_PAUSE_MS = 40_000; // safely past the ~30s failure window in #366

/**
 * A deterministic, byte-cheap synthetic payload: each 4 MiB chunk is filled
 * with a single repeated byte equal to its own (0-based) index mod 256. A
 * truncated or reordered download is then verifiable from the saved file's
 * size and per-chunk byte value alone, with no need to buffer or hash
 * anything while generating it. See verify.mjs.
 */
const makeTestStream = (onProgress, pauseMs = DEFAULT_PAUSE_MS) => {
    let chunkIndex = 0;
    return new ReadableStream({
        async pull(controller) {
            if (chunkIndex >= CHUNK_COUNT) {
                controller.close();
                return;
            }

            const chunk = new Uint8Array(CHUNK_SIZE);
            chunk.fill(chunkIndex & 0xff);
            controller.enqueue(chunk);
            chunkIndex++;
            onProgress(chunkIndex);

            if (
                chunkIndex % PAUSE_EVERY_N_CHUNKS == 0 &&
                chunkIndex < CHUNK_COUNT
            ) {
                await new Promise((resolve) => setTimeout(resolve, pauseMs));
            }
        },
    });
};

const runTest = async (label, pingIntervalMs, setRun, pauseMs) => {
    setRun({ label, status: "running", sentChunks: 0 });
    const fileName = `stream-test-${label}-${Date.now()}.bin`;
    const controller = new AbortController();
    try {
        await streamDownload(
            fileName,
            makeTestStream(
                (sentChunks) => setRun({ label, status: "running", sentChunks }),
                pauseMs,
            ),
            controller.signal,
            { pingIntervalMs },
        );
        setRun({ label, status: "done", sentChunks: CHUNK_COUNT });
    } catch (e) {
        const message =
            e instanceof StreamDownloadUnavailable
                ? `Streaming is unavailable in this browser/tab: ${e.message}`
                : e instanceof Error
                  ? e.message
                  : String(e);
        setRun({ label, status: "failed", sentChunks: 0, message });
    }
};

const runsEl = document.getElementById("runs");
const runs = new Map();
let busy = false;

const render = () => {
    runsEl.innerHTML = "";
    for (const run of runs.values()) {
        const li = document.createElement("li");
        li.innerHTML = `<strong>${run.label}</strong>: ${run.status} (${run.sentChunks}/${CHUNK_COUNT} chunks sent)${run.message ? ` — ${escapeHtml(run.message)}` : ""}`;
        runsEl.appendChild(li);
    }
    for (const button of document.querySelectorAll("button[data-start]")) {
        button.disabled = busy;
    }
};

const escapeHtml = (s) =>
    s.replace(
        /[&<>"']/g,
        (c) =>
            ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
            })[c],
    );

const setRun = (run) => {
    runs.set(run.label, run);
    render();
};

const start = (label, pingIntervalMs, pauseMs) => {
    if (busy) return;
    busy = true;
    render();
    void runTest(label, pingIntervalMs, setRun, pauseMs).finally(() => {
        busy = false;
        render();
    });
};

for (const button of document.querySelectorAll("button[data-start]")) {
    const [label, pingIntervalMs, pauseMs] = button.dataset.start.split(",");
    button.addEventListener("click", () =>
        start(
            label,
            Number(pingIntervalMs),
            pauseMs ? Number(pauseMs) : undefined,
        ),
    );
}

render();
