#!/usr/bin/env node
// Verifies a file downloaded by this repo's test page: checks that every
// 4 MiB-aligned block's bytes all equal that block's 0-based index mod 256,
// and that the file is the expected total size. A truncated, reordered, or
// corrupted download (e.g. the service worker being killed mid-stream, as in
// https://github.com/jimmywarting/StreamSaver.js/issues/366) will fail one
// of these checks.
//
// Usage: node verify.mjs <path to downloaded file>

import { open } from "node:fs/promises";

const CHUNK_SIZE = 4 * 1024 * 1024;
const CHUNK_COUNT = 32;
const EXPECTED_SIZE = CHUNK_SIZE * CHUNK_COUNT;

const path = process.argv[2];
if (!path) {
    console.error("Usage: node verify.mjs <path>");
    process.exit(2);
}

const file = await open(path, "r");
try {
    const { size } = await file.stat();
    if (size != EXPECTED_SIZE) {
        console.error(
            `FAIL: file is ${size} bytes, expected ${EXPECTED_SIZE} ` +
                `(${((size / EXPECTED_SIZE) * 100).toFixed(1)}% complete) ` +
                "- the download was truncated.",
        );
        process.exit(1);
    }

    const buffer = Buffer.alloc(CHUNK_SIZE);
    for (let chunkIndex = 0; chunkIndex < CHUNK_COUNT; chunkIndex++) {
        const { bytesRead } = await file.read(
            buffer,
            0,
            CHUNK_SIZE,
            chunkIndex * CHUNK_SIZE,
        );
        if (bytesRead != CHUNK_SIZE) {
            console.error(
                `FAIL: short read at chunk ${chunkIndex} (${bytesRead} bytes).`,
            );
            process.exit(1);
        }
        const expectedByte = chunkIndex & 0xff;
        for (let i = 0; i < CHUNK_SIZE; i++) {
            if (buffer[i] != expectedByte) {
                console.error(
                    `FAIL: chunk ${chunkIndex}, offset ${i} is ` +
                        `0x${buffer[i].toString(16)}, expected ` +
                        `0x${expectedByte.toString(16)} - the download is corrupted.`,
                );
                process.exit(1);
            }
        }
    }

    console.log(
        `PASS: ${EXPECTED_SIZE} bytes, all ${CHUNK_COUNT} chunks intact.`,
    );
} finally {
    await file.close();
}
