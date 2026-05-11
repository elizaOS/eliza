#!/usr/bin/env node
/**
 * VAD quality + latency harness.
 *
 * This drives the real app-core VAD implementation through Bun so the TS
 * runtime, Silero model loader, and VadDetector state machine are measured
 * together. It records hard metrics for publish gates when a VAD model is
 * present, and records an explicit unavailable/needs-data report otherwise.
 *
 * Usage:
 *   node packages/inference/verify/vad_quality_harness.mjs [--bundle PATH] [--report PATH] [--json]
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_REPORT = path.join(
  __dirname,
  "..",
  "reports",
  "vad",
  `vad-quality-${timestamp()}.json`,
);

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function parseArgs(argv) {
  const args = { bundle: null, report: DEFAULT_REPORT, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--bundle") {
      i += 1;
      args.bundle = argv[i] ?? null;
    } else if (a === "--report") {
      i += 1;
      args.report = argv[i] ?? DEFAULT_REPORT;
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node vad_quality_harness.mjs [--bundle PATH] [--report PATH] [--json]",
      );
      process.exit(0);
    }
  }
  return args;
}

function typescriptRunner() {
  const direct = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (direct.status === 0) return { cmd: "bun", args: [] };
  const which = spawnSync("bash", ["-lc", "command -v bun"], {
    encoding: "utf8",
  });
  const p = which.stdout?.trim();
  if (which.status === 0 && p) return { cmd: p, args: [] };
  if (fs.existsSync(path.join(REPO_ROOT, "node_modules", ".bin", "tsx"))) {
    return { cmd: process.execPath, args: ["--import", "tsx"] };
  }
  return null;
}

function writeReport(args, report) {
  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`wrote ${args.report}`);
    console.log(
      `vad-quality: available=${report.available} reason=${report.reason ?? "ok"}`,
    );
  }
}

function unavailable(args, reason, extra = {}) {
  writeReport(args, {
    generatedAt: new Date().toISOString(),
    harness: path.relative(process.cwd(), __filename),
    available: false,
    reason,
    ...extra,
    summary: {
      vadLatencyMs: null,
      vadBoundaryMaeMs: null,
      vadEndpointP95Ms: null,
      vadFalseBargeInPerHour: null,
      samples: 0,
    },
  });
}

function makeRunnerSource(bundleRoot) {
  const vadUrl = pathToFileURL(
    path.join(
      REPO_ROOT,
      "packages",
      "app-core",
      "src",
      "services",
      "local-inference",
      "voice",
      "vad.ts",
    ),
  ).href;
  const fixtureUrl = pathToFileURL(
    path.join(
      REPO_ROOT,
      "packages",
      "app-core",
      "src",
      "services",
      "local-inference",
      "voice",
      "__test-helpers__",
      "synthetic-speech.ts",
    ),
  ).href;

  return `
import { performance } from "node:perf_hooks";
import { createSileroVadDetector, resolveSileroVadPath, SileroVad } from ${JSON.stringify(vadUrl)};
import { makeSpeechWithSilenceFixture } from ${JSON.stringify(fixtureUrl)};

const SR = 16000;
const WINDOW = 512;
const bundleRoot = ${JSON.stringify(bundleRoot)};
const modelPath = process.env.ELIZA_VAD_MODEL_PATH || undefined;
const resolved = resolveSileroVadPath({ modelPath, bundleRoot });
if (!resolved) {
  console.log(JSON.stringify({ available: false, reason: "no Silero VAD model found" }));
  process.exit(0);
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function percentile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

function makeNoiseFrame(seed) {
  const pcm = new Float32Array(WINDOW);
  let x = seed || 1;
  for (let i = 0; i < pcm.length; i += 1) {
    x = (1664525 * x + 1013904223) >>> 0;
    pcm[i] = (((x / 0xffffffff) * 2) - 1) * 0.04;
  }
  return pcm;
}

const vad = await SileroVad.load({ modelPath: resolved });
const silence = new Float32Array(WINDOW);
const computeMs = [];
vad.reset();
for (let i = 0; i < 80; i += 1) {
  const t0 = performance.now();
  await vad.process(silence);
  computeMs.push(performance.now() - t0);
}

const fixtureRows = [];
for (const speechSec of [0.35, 0.6, 1.2, 2.4]) {
  const det = await createSileroVadDetector({
    modelPath: resolved,
    config: {
      onsetThreshold: 0.5,
      pauseHangoverMs: 220,
      endHangoverMs: 500,
      minSpeechMs: 150,
    },
  });
  const fx = makeSpeechWithSilenceFixture({
    sampleRate: SR,
    leadSilenceSec: 0.6,
    speechSec,
    tailSilenceSec: 0.8,
  });
  const expectedStartMs = (fx.speechStartSample / SR) * 1000;
  const expectedEndMs = (fx.speechEndSample / SR) * 1000;
  const events = [];
  det.onVadEvent((e) => events.push(e));
  for (let i = 0; (i + 1) * WINDOW <= fx.pcm.length; i += 1) {
    await det.pushFrame({
      pcm: fx.pcm.slice(i * WINDOW, (i + 1) * WINDOW),
      sampleRate: SR,
      timestampMs: (i * WINDOW * 1000) / SR,
    });
  }
  await det.flush();
  const starts = events.filter((e) => e.type === "speech-start");
  const ends = events.filter((e) => e.type === "speech-end");
  const startMs = starts[0]?.timestampMs ?? null;
  const endMs = ends[0]?.timestampMs ?? null;
  fixtureRows.push({
    speechSec,
    expectedStartMs,
    expectedEndMs,
    startMs,
    endMs,
    onsetErrorMs: startMs === null ? null : Math.abs(startMs - expectedStartMs),
    endpointOverhangMs: endMs === null ? null : Math.max(0, endMs - expectedEndMs),
    starts: starts.length,
    ends: ends.length,
  });
}

const silenceDet = await createSileroVadDetector({
  modelPath: resolved,
  config: {
    onsetThreshold: 0.5,
    pauseHangoverMs: 220,
    endHangoverMs: 500,
    minSpeechMs: 150,
  },
});
let falseStarts = 0;
silenceDet.onVadEvent((e) => {
  if (e.type === "speech-start") falseStarts += 1;
});
let ts = 0;
const silenceFrames = 1200; // 38.4 simulated seconds.
for (let i = 0; i < silenceFrames; i += 1) {
  const pcm = i % 10 === 0 ? makeNoiseFrame(i + 1) : new Float32Array(WINDOW);
  await silenceDet.pushFrame({ pcm, sampleRate: SR, timestampMs: ts });
  ts += (WINDOW * 1000) / SR;
}
await silenceDet.flush();
const simulatedHours = (silenceFrames * WINDOW / SR) / 3600;
const falseBargeInPerHour = falseStarts / simulatedHours;

const onsetErrors = fixtureRows.map((r) => r.onsetErrorMs).filter((v) => v !== null);
const endpointOverhangs = fixtureRows.map((r) => r.endpointOverhangMs).filter((v) => v !== null);
console.log(JSON.stringify({
  available: true,
  modelPath: resolved,
  fixtures: fixtureRows,
  summary: {
    vadLatencyMs: median(computeMs),
    vadLatencyP95Ms: percentile(computeMs, 0.95),
    vadBoundaryMaeMs: median(onsetErrors),
    vadEndpointP95Ms: percentile(endpointOverhangs, 0.95),
    vadFalseBargeInPerHour: falseBargeInPerHour,
    samples: fixtureRows.length,
  },
}));
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runnerRuntime = typescriptRunner();
  if (!runnerRuntime) {
    unavailable(
      args,
      "bun or node --import tsx is required to import and run the TypeScript VAD runtime",
    );
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-vad-quality-"));
  const runner = path.join(tmp, "run.mjs");
  fs.writeFileSync(runner, makeRunnerSource(args.bundle), "utf8");

  const child = spawnSync(runnerRuntime.cmd, [...runnerRuntime.args, runner], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (child.status !== 0) {
    unavailable(args, "VAD quality runner failed", {
      exitCode: child.status,
      stderr: child.stderr,
      stdout: child.stdout,
    });
    return;
  }

  let payload;
  try {
    const lines = child.stdout.trim().split(/\r?\n/).filter(Boolean);
    payload = JSON.parse(lines[lines.length - 1] ?? "{}");
  } catch (err) {
    unavailable(args, "VAD quality runner did not emit JSON", {
      stdout: child.stdout,
      stderr: child.stderr,
      parseError: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!payload.available) {
    unavailable(args, payload.reason ?? "VAD model unavailable", {
      runner: path.relative(process.cwd(), runner),
    });
    return;
  }

  writeReport(args, {
    generatedAt: new Date().toISOString(),
    harness: path.relative(process.cwd(), __filename),
    available: true,
    modelPath: payload.modelPath,
    fixtures: payload.fixtures,
    summary: payload.summary,
  });
}

main();
