#!/usr/bin/env node
/**
 * Synthetic e2e run generator for exercising the AI review orchestrator:
 * writes two contract-shaped test bundles (one passed, one failed with a
 * planted console TypeError and a missing POST) under the standard artifacts
 * root (`<repo>/e2e/<run-id>`, gitignored; `ELIZA_E2E_ARTIFACTS_DIR`
 * overrides). Every artifact kind the prompt builder inlines is present —
 * logs, OCR, trajectory jsonl, posthog events, and real PNG state
 * screenshots (encoded here dependency-free) so codex `-i` attachment can be
 * smoke-tested against actual image bytes.
 *
 *   node scripts/e2e-ai-review/fixtures/make-fixture-run.mjs [--run <id>]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import zlib from "node:zlib";
import {
  testDir,
  writeRunIndex,
  writeTestManifest,
} from "../../e2e-artifacts/contract.mjs";

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../..",
);

const { values } = parseArgs({
  options: { run: { type: "string", default: "fixture-ai-review" } },
});
const runId = values.run;

// Minimal PNG encoder (truecolor, no filtering beyond per-row 0) so the
// fixture ships no image bytes in git and no image dependency.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
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

function makePng(width, height, rgbAt) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = rgbAt(x, y);
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const okScreenshot = makePng(160, 100, (x, y) =>
  y < 20 ? [40, 40, 48] : x % 40 < 20 ? [230, 230, 235] : [200, 120, 40],
);
const brokenScreenshot = makePng(160, 100, (_x, y) =>
  y < 20 ? [40, 40, 48] : [180, 30, 30],
);

function writeBundle({ id, title, status, files, artifacts, timing }) {
  const dir = testDir(REPO_ROOT, runId, id);
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  writeTestManifest(dir, {
    id,
    runId,
    lane: "fixture",
    project: "chromium",
    file: "chat.spec.ts",
    title,
    status,
    durationMs: timing.durationMs,
    startedAt: timing.startedAt,
    finishedAt: timing.finishedAt,
    artifacts,
  });
  return dir;
}

const passTrajectory = [
  {
    model: "gpt-fixture",
    prompt: "User says: hello — reply briefly.",
    response: "Hey! How can I help today?",
    toolCalls: [],
  },
  {
    model: "gpt-fixture",
    prompt: "Summarize the conversation so far.",
    response: "User greeted the agent; agent replied.",
    toolCalls: [{ name: "SUMMARIZE" }],
  },
]
  .map((call) => JSON.stringify(call))
  .join("\n");

writeBundle({
  id: "fixture:chat.spec.ts:sends a message",
  title: "sends a message",
  status: "passed",
  timing: {
    durationMs: 2140,
    startedAt: "2026-07-09T10:00:00.000Z",
    finishedAt: "2026-07-09T10:00:02.140Z",
  },
  files: {
    "logs/console.log": [
      "[info] app booted in 812ms",
      "[info] websocket connected",
      "[info] composer submit -> POST /api/messages",
      "[info] agent reply rendered in 640ms",
    ].join("\n"),
    "logs/network.log": [
      "GET /api/agents 200 34ms",
      "POST /api/messages 201 118ms",
      "GET /api/messages?roomId=r1 200 22ms",
    ].join("\n"),
    "logs/server.log": [
      "[MessageService] persisted message m-1 room r1",
      "[AgentRuntime] reply dispatched for room r1",
    ].join("\n"),
    "ocr/states.txt": "Chat\nType a message\nSend\nHey! How can I help today?",
    "trajectory/trajectory.jsonl": passTrajectory,
    "posthog/events.jsonl": [
      JSON.stringify({ event: "$pageview" }),
      JSON.stringify({ event: "chat_message_sent" }),
      JSON.stringify({ event: "chat_reply_rendered" }),
    ].join("\n"),
    "screens/01-composed.png": okScreenshot,
    "screens/02-replied.png": okScreenshot,
  },
  artifacts: [
    { kind: "console-log", path: "logs/console.log" },
    { kind: "network-log", path: "logs/network.log" },
    { kind: "server-log", path: "logs/server.log" },
    { kind: "ocr", path: "ocr/states.txt" },
    { kind: "trajectory", path: "trajectory/trajectory.jsonl" },
    { kind: "posthog-events", path: "posthog/events.jsonl" },
    {
      kind: "state-screenshot",
      path: "screens/01-composed.png",
      stateName: "composed",
    },
    {
      kind: "state-screenshot",
      path: "screens/02-replied.png",
      stateName: "replied",
    },
  ],
});

writeBundle({
  id: "fixture:chat.spec.ts:shows agent reply",
  title: "shows agent reply",
  status: "failed",
  timing: {
    durationMs: 30890,
    startedAt: "2026-07-09T10:00:03.000Z",
    finishedAt: "2026-07-09T10:00:33.890Z",
  },
  files: {
    "logs/console.log": [
      "[info] app booted in 795ms",
      "[info] websocket connected",
      "[error] Uncaught TypeError: Cannot read properties of null (reading 'value') at Composer.submit (Composer.tsx:88)",
      "[error] test timeout: expected reply bubble to appear within 30000ms",
    ].join("\n"),
    "logs/network.log": [
      "GET /api/agents 200 31ms",
      "GET /api/messages?roomId=r1 200 25ms",
      "(no POST /api/messages observed)",
    ].join("\n"),
    "logs/server.log": [
      "[MessageService] no inbound message for room r1 in this window",
    ].join("\n"),
    "ocr/states.txt": "Chat\nType a message\nSend",
    "trajectory/trajectory.jsonl": JSON.stringify({
      model: "gpt-fixture",
      prompt: "(no user message ever arrived)",
      response: "",
      toolCalls: [],
    }),
    "posthog/events.jsonl": [
      JSON.stringify({ event: "$pageview" }),
      JSON.stringify({
        event: "$exception",
        properties: {
          message: "Cannot read properties of null (reading 'value')",
        },
      }),
    ].join("\n"),
    "screens/01-stuck.png": brokenScreenshot,
  },
  artifacts: [
    { kind: "console-log", path: "logs/console.log" },
    { kind: "network-log", path: "logs/network.log" },
    { kind: "server-log", path: "logs/server.log" },
    { kind: "ocr", path: "ocr/states.txt" },
    { kind: "trajectory", path: "trajectory/trajectory.jsonl" },
    { kind: "posthog-events", path: "posthog/events.jsonl" },
    {
      kind: "state-screenshot",
      path: "screens/01-stuck.png",
      stateName: "stuck",
    },
  ],
});

const index = writeRunIndex(REPO_ROOT, runId);
console.log(
  `[fixture] wrote run ${runId}: ${index.testCount} tests (${JSON.stringify(index.statusCounts)})`,
);
