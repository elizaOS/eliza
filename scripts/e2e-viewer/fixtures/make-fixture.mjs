/**
 * Writes a synthetic e2e artifact run through the shared contract so the
 * viewer can be exercised (and screenshotted) without running any real test
 * lane. Produces three tests under run `run-fixture-viewer`: a pass with
 * state screenshots + console/network JSONL + a trajectory, a fail with an
 * error, and a pass carrying a PostHog snapshots JSONL whose lines wrap a
 * real (minimal) rrweb Meta/FullSnapshot/IncrementalSnapshot sequence.
 * Everything lands under the gitignored artifacts root.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { testDir, writeRunIndex, writeTestManifest } from "../../e2e-artifacts/contract.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const FIXTURE_RUN_ID = "run-fixture-viewer";

// ---- minimal PNG encoder ----------------------------------------------------
// A solid-colour truecolour PNG built by hand: IHDR + deflated scanlines +
// IEND. Keeps the fixture free of image dependencies while producing files
// every browser renders.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function makePng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const row = Buffer.alloc(1 + width * 3); // leading 0 = "None" filter
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- fixture tests ----------------------------------------------------------

function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

const startedAt = "2026-07-09T10:00:00.000Z";

function writePassingTest() {
  const id = "app-e2e:chat.spec.ts:chat > sends a message and renders the reply";
  const dir = testDir(repoRoot, FIXTURE_RUN_ID, id);
  writeFile(dir, "states/01-initial.png", makePng(320, 200, [38, 42, 66]));
  writeFile(dir, "states/02-after-send.png", makePng(320, 200, [30, 84, 52]));
  writeFile(
    dir,
    "console.jsonl",
    jsonl([
      { ts: 1783418400123, level: "info", text: "[App] boot complete" },
      { ts: 1783418401001, level: "info", text: "[Chat] message submitted" },
      { ts: 1783418403420, level: "warn", text: "[Chat] slow model response (2.4s)" },
      { ts: 1783418403555, level: "info", text: "[Chat] reply rendered" },
    ]),
  );
  writeFile(
    dir,
    "network.jsonl",
    jsonl([
      { ts: 1783418400200, method: "GET", url: "/api/agents", status: 200 },
      { ts: 1783418401050, method: "POST", url: "/api/messaging/submit", status: 200 },
      { ts: 1783418403400, method: "GET", url: "/api/media/abc123.png", status: 200 },
    ]),
  );
  writeFile(
    dir,
    "trajectory.json",
    `${JSON.stringify(
      {
        stages: [
          {
            name: "shouldRespond",
            model: "test-model-large",
            prompt: "# Task: decide whether Eliza should respond\nRoom: #general\nUser: hello, can you summarize my inbox?",
            response: "RESPOND",
            usage: { promptTokens: 812, completionTokens: 4 },
          },
          {
            name: "reply",
            model: "test-model-large",
            prompt: "# Task: write Eliza's reply\nUser asked: summarize my inbox.\nContext: 3 unread emails.",
            response: "You have 3 unread emails: two newsletters and one from Ana about tomorrow's standup.",
            usage: { promptTokens: 1490, completionTokens: 42 },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeTestManifest(dir, {
    id,
    runId: FIXTURE_RUN_ID,
    lane: "app-e2e",
    project: "chromium",
    file: "chat.spec.ts",
    title: "chat > sends a message and renders the reply",
    status: "pass",
    durationMs: 8342,
    startedAt,
    finishedAt: "2026-07-09T10:00:08.342Z",
    artifacts: [
      { kind: "state-screenshot", path: "states/01-initial.png", stateName: "initial" },
      { kind: "state-screenshot", path: "states/02-after-send.png", stateName: "after-send" },
      { kind: "console-log", path: "console.jsonl", label: "browser console" },
      { kind: "network-log", path: "network.jsonl", label: "network requests" },
      { kind: "trajectory", path: "trajectory.json", label: "agent trajectory" },
    ],
    links: { issue: "https://github.com/elizaOS/eliza/issues/15972" },
  });
}

function writeFailingTest() {
  const id = "app-e2e:settings.spec.ts:settings > persists the theme choice";
  const dir = testDir(repoRoot, FIXTURE_RUN_ID, id);
  writeFile(dir, "failure.png", makePng(320, 200, [96, 34, 34]));
  writeFile(
    dir,
    "console.jsonl",
    jsonl([
      { ts: 1783418410000, level: "info", text: "[Settings] opened" },
      { ts: 1783418412000, level: "error", text: "[Settings] PUT /api/settings failed: 500" },
    ]),
  );
  writeTestManifest(dir, {
    id,
    runId: FIXTURE_RUN_ID,
    lane: "app-e2e",
    project: "chromium",
    file: "settings.spec.ts",
    title: "settings > persists the theme choice",
    status: "fail",
    durationMs: 15021,
    startedAt,
    finishedAt: "2026-07-09T10:00:15.021Z",
    error: {
      message: "expect(locator('.theme-badge')).toHaveText('dark') failed: element not found",
      stack:
        "Error: expect(locator('.theme-badge')).toHaveText('dark')\n    at settings.spec.ts:42:31\n    at runTest (playwright/lib/worker.js:101:9)",
    },
    artifacts: [
      { kind: "screenshot", path: "failure.png", label: "at failure" },
      { kind: "console-log", path: "console.jsonl", label: "browser console" },
    ],
  });
}

/**
 * Minimal but real rrweb sequence: Meta (viewport), FullSnapshot (a document
 * with html/head/body and one text node), then IncrementalSnapshots (mouse
 * moves + a text mutation) — the smallest stream rrweb-player accepts.
 */
function rrwebEvents() {
  const t0 = 1783418420000;
  const fullSnapshot = {
    type: 2,
    timestamp: t0 + 10,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [
          {
            type: 2,
            tagName: "html",
            attributes: {},
            id: 2,
            childNodes: [
              { type: 2, tagName: "head", attributes: {}, id: 3, childNodes: [] },
              {
                type: 2,
                tagName: "body",
                attributes: { style: "margin:0;background:#f7f4ef" },
                id: 4,
                childNodes: [
                  {
                    type: 2,
                    tagName: "div",
                    attributes: { style: "font:18px sans-serif;padding:32px;color:#1a1a1a" },
                    id: 5,
                    childNodes: [{ type: 3, textContent: "Hello from the rrweb fixture", id: 6 }],
                  },
                ],
              },
            ],
          },
        ],
      },
      initialOffset: { left: 0, top: 0 },
    },
  };
  return {
    meta: { type: 4, timestamp: t0, data: { href: "http://localhost:2138/", width: 800, height: 600 } },
    fullSnapshot,
    incrementals: [
      {
        type: 3,
        timestamp: t0 + 600,
        data: {
          source: 1, // MouseMove
          positions: [
            { x: 120, y: 90, id: 5, timeOffset: -80 },
            { x: 240, y: 140, id: 5, timeOffset: 0 },
          ],
        },
      },
      {
        type: 3,
        timestamp: t0 + 1400,
        data: {
          source: 0, // Mutation: append a second text node to the div
          texts: [],
          attributes: [],
          removes: [],
          adds: [
            {
              parentId: 5,
              nextId: null,
              node: { type: 3, textContent: " — and it just mutated.", id: 7 },
            },
          ],
        },
      },
    ],
  };
}

function writeReplayTest() {
  const id = "ui-e2e:stream.scenario.ts:stream view > records a session replay";
  const dir = testDir(repoRoot, FIXTURE_RUN_ID, id);
  const { meta, fullSnapshot, incrementals } = rrwebEvents();
  writeFile(
    dir,
    "snapshots.jsonl",
    jsonl([
      {
        event: "$snapshot",
        properties: { $session_id: "fixture-session", $snapshot_data: [meta, fullSnapshot] },
      },
      {
        event: "$snapshot",
        properties: { $session_id: "fixture-session", $snapshot_data: incrementals },
      },
    ]),
  );
  writeTestManifest(dir, {
    id,
    runId: FIXTURE_RUN_ID,
    lane: "ui-e2e",
    project: null,
    file: "stream.scenario.ts",
    title: "stream view > records a session replay",
    status: "pass",
    durationMs: 4210,
    startedAt,
    finishedAt: "2026-07-09T10:00:04.210Z",
    artifacts: [{ kind: "posthog-snapshots", path: "snapshots.jsonl", label: "posthog session recording" }],
  });
}

writePassingTest();
writeFailingTest();
writeReplayTest();
const index = writeRunIndex(repoRoot, FIXTURE_RUN_ID);
console.log(`[make-fixture] wrote run ${FIXTURE_RUN_ID}: ${index.testCount} tests (${JSON.stringify(index.statusCounts)})`);
