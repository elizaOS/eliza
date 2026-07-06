#!/usr/bin/env node
/**
 * Real end-to-end smoke test for the GPU vision service. It renders a
 * deterministic fixture PNG containing known text, POSTs it to a running
 * llama-server's OpenAI-compatible chat endpoint with the grounding OCR prompt
 * at temp 0, and asserts the known strings come back in the transcription. This
 * proves the actual model is loaded and transcribing pixels — not a mock — which
 * is the bar the evidence harness holds every analyzer to.
 *
 * Fixture is generated in-process with sharp (SVG text → PNG, a repo dependency)
 * so there is no binary asset to check in and the expected text is defined right
 * next to the assertion. On mismatch the script prints the expected-vs-got diff
 * and exits nonzero; capture latency and token counts are printed on success.
 *
 * The server base URL is taken from --url, else ELIZA_GPU_VISION_PORT, else the
 * running instance recorded in serve.json. --start is the one-shot convenience
 * path: setup (if needed) → serve → smoke → stop.
 *
 * Usage:
 *   node scripts/gpu-vision/smoke.mjs [--url http://127.0.0.1:PORT] [--vlm]
 *   node scripts/gpu-vision/smoke.mjs --start [--vlm] [--with-vlm]
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  cacheDir,
  MODEL_SETS,
  OCR_PROMPT,
  parseArgs,
  serveStatePath,
  waitForReady,
} from "./lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = {
  setup: path.join(__dirname, "setup.mjs"),
  serve: path.join(__dirname, "serve.mjs"),
};

// Distinctive tokens: an unlikely alphanumeric code plus two plain words, so a
// pass requires transcribing arbitrary characters, not echoing a common phrase.
const FIXTURE_LINES = [
  "ELIZA VISION LANE",
  "OCR-CODE-4F2A9",
  "unlimited ocr smoke",
];

async function renderFixture() {
  const width = 900;
  const lineHeight = 90;
  const height = lineHeight * (FIXTURE_LINES.length + 1);
  const texts = FIXTURE_LINES.map(
    (line, i) =>
      `<text x="50" y="${lineHeight * (i + 1)}" font-family="Helvetica, Arial, sans-serif" font-size="52" fill="#000000">${line}</text>`,
  ).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#ffffff"/>${texts}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function resolveBaseUrl(flags, setKey) {
  if (flags.url) return String(flags.url).replace(/\/$/, "");
  if (process.env.ELIZA_GPU_VISION_PORT) {
    return `http://127.0.0.1:${Number(process.env.ELIZA_GPU_VISION_PORT)}`;
  }
  const state = JSON.parse(
    await fs.readFile(serveStatePath(), "utf8").catch(() => "{}"),
  );
  const entry = state[setKey];
  if (!entry) {
    throw new Error(
      "[gpu-vision] no running server found. Pass --url, set ELIZA_GPU_VISION_PORT, " +
        "or start one: node scripts/gpu-vision/serve.mjs" +
        (setKey === "vlm" ? " --vlm" : ""),
    );
  }
  return `http://127.0.0.1:${entry.port}`;
}

async function runOcr(baseUrl, pngBuffer) {
  const dataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
  const body = {
    model: "gpu-vision",
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: OCR_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  };
  const started = Date.now();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[gpu-vision] chat completion HTTP ${res.status}: ${text.slice(0, 400)}`,
    );
  }
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error(
      `[gpu-vision] unexpected response shape: ${JSON.stringify(json).slice(0, 400)}`,
    );
  }
  return { text, latencyMs, usage: json.usage ?? null };
}

/** Case-insensitive, whitespace-collapsed substring check so minor formatting
 * (extra spaces, casing) doesn't fail a genuinely-correct transcription. */
function normalize(s) {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function assertContainsAll(transcription, expectedLines) {
  const hay = normalize(transcription);
  const missing = expectedLines.filter(
    (line) => !hay.includes(normalize(line)),
  );
  return { ok: missing.length === 0, missing };
}

async function smoke(baseUrl) {
  await waitForReady(`${baseUrl}/health`, { timeoutMs: 15000 });
  const png = await renderFixture();
  process.stdout.write(
    `[gpu-vision] fixture: ${png.length} byte PNG, expecting ${FIXTURE_LINES.length} lines\n`,
  );

  const { text, latencyMs, usage } = await runOcr(baseUrl, png);
  process.stdout.write(
    `\n[gpu-vision] transcription (${latencyMs} ms):\n${text}\n\n`,
  );

  const { ok, missing } = assertContainsAll(text, FIXTURE_LINES);
  if (usage) {
    process.stdout.write(
      `[gpu-vision] tokens: prompt=${usage.prompt_tokens ?? "?"} completion=${usage.completion_tokens ?? "?"} total=${usage.total_tokens ?? "?"}\n`,
    );
  }
  process.stdout.write(`[gpu-vision] latency: ${latencyMs} ms\n`);

  if (!ok) {
    process.stderr.write(
      "\n[gpu-vision] SMOKE FAILED — expected strings not found in transcription:\n",
    );
    for (const line of missing)
      process.stderr.write(`  MISSING: ${JSON.stringify(line)}\n`);
    process.stderr.write(
      `\n  expected all of: ${JSON.stringify(FIXTURE_LINES)}\n`,
    );
    process.stderr.write(`  got: ${JSON.stringify(text)}\n`);
    process.exit(1);
  }
  process.stdout.write(
    "\n[gpu-vision] SMOKE PASSED — all expected strings transcribed.\n",
  );
}

function runScript(scriptPath, args) {
  const result = spawnSync("node", [scriptPath, ...args], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `[gpu-vision] ${path.basename(scriptPath)} ${args.join(" ")} exited ${result.status}`,
    );
  }
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), {
    booleans: ["vlm", "start", "with-vlm"],
  });
  const setKey = flags.vlm ? "vlm" : "ocr";

  if (flags.start) {
    // One-shot: fetch models if needed, serve, smoke, then always stop.
    runScript(
      SCRIPTS.setup,
      flags["with-vlm"] || setKey === "vlm" ? ["--with-vlm"] : [],
    );
    const serveArgs = setKey === "vlm" ? ["--vlm"] : [];
    runScript(SCRIPTS.serve, serveArgs);
    try {
      const baseUrl = await resolveBaseUrl(flags, setKey);
      await smoke(baseUrl);
    } finally {
      runScript(SCRIPTS.serve, [
        "--stop",
        ...(setKey === "vlm" ? ["--vlm"] : []),
      ]);
    }
    return;
  }

  const baseUrl = await resolveBaseUrl(flags, setKey);
  process.stdout.write(
    `[gpu-vision] target: ${baseUrl} (${MODEL_SETS[setKey].label})\n`,
  );
  process.stdout.write(`[gpu-vision] cache: ${cacheDir()}\n`);
  await smoke(baseUrl);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
