#!/usr/bin/env node
/**
 * Launches and supervises a resident `llama-server` for the GPU vision lane. One
 * server holds the model in VRAM and serves an OpenAI-compatible endpoint with
 * `--parallel N` slots; the analyzer registry queues jobs against it rather than
 * loading a model per image. Serves Unlimited-OCR by default, or Qwen3-VL under
 * --vlm (a second instance keyed by model in the shared serve.json).
 *
 * Readiness is confirmed by polling /health before we report the base URL, so a
 * caller that sees a URL can trust the server answers. The PID/port/model are
 * recorded to serve.json so --stop can terminate the exact instance and the
 * analyzer registry can discover a running endpoint without env plumbing.
 *
 * The DeepSeek-OCR mmproj needs llama.cpp ≥ b8525 (PR 17400, 2026-03-25); an
 * older or missing binary fails here with an actionable upgrade message rather
 * than a cryptic model-load error deep in the server.
 *
 * Usage:
 *   node scripts/gpu-vision/serve.mjs [--vlm] [--parallel N] [--port P]
 *   node scripts/gpu-vision/serve.mjs --stop [--vlm]
 */

import { spawn, spawnSync } from "node:child_process";
import { openSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  cacheDir,
  findFreePort,
  MIN_LLAMA_BUILD,
  MODEL_SETS,
  modelFilePath,
  parseArgs,
  parseLlamaBuild,
  serveStatePath,
  waitForReady,
} from "./lib.mjs";

const CONTEXT_SIZE = 8192;
const DEFAULT_PARALLEL = 2;

function requireLlamaServer() {
  const probe = spawnSync("llama-server", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      "[gpu-vision] llama-server not found on PATH.\n" +
        "  Install it: `brew install llama.cpp` (macOS) or build llama.cpp with your GPU backend.\n" +
        "  The DeepSeek-OCR mmproj requires build b8525 or newer (2026-03-25+).",
    );
  }
  // llama.cpp prints version to stderr.
  const versionText = `${probe.stdout || ""}${probe.stderr || ""}`;
  const build = parseLlamaBuild(versionText);
  if (build === null) {
    throw new Error(
      `[gpu-vision] could not parse llama-server version from:\n${versionText}`,
    );
  }
  if (build < MIN_LLAMA_BUILD) {
    throw new Error(
      `[gpu-vision] llama-server build ${build} is too old for DeepSeek-OCR models.\n` +
        `  Need build ≥ ${MIN_LLAMA_BUILD} (PR 17400, merged 2026-03-25).\n` +
        "  Upgrade: `brew upgrade llama.cpp`.",
    );
  }
  return build;
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(serveStatePath(), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function writeState(state) {
  await fs.mkdir(cacheDir(), { recursive: true });
  await fs.writeFile(
    serveStatePath(),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stop(setKey) {
  const state = await readState();
  const entry = state[setKey];
  if (!entry) {
    process.stdout.write(
      `[gpu-vision] no recorded ${setKey} server in serve.json\n`,
    );
    return;
  }
  if (processAlive(entry.pid)) {
    process.kill(entry.pid, "SIGTERM");
    process.stdout.write(
      `[gpu-vision] stopped ${setKey} server pid ${entry.pid} (port ${entry.port})\n`,
    );
  } else {
    process.stdout.write(
      `[gpu-vision] ${setKey} server pid ${entry.pid} already gone\n`,
    );
  }
  delete state[setKey];
  await writeState(state);
}

async function serve({ setKey, parallel, requestedPort }) {
  const build = requireLlamaServer();
  const set = MODEL_SETS[setKey];
  const modelPath = modelFilePath(setKey, "model");
  const mmprojPath = modelFilePath(setKey, "mmproj");
  for (const p of [modelPath, mmprojPath]) {
    await fs.access(p).catch(() => {
      throw new Error(
        `[gpu-vision] missing model file: ${p}\n  Run: node scripts/gpu-vision/setup.mjs${setKey === "vlm" ? " --with-vlm" : ""}`,
      );
    });
  }

  const state = await readState();
  const existing = state[setKey];
  if (existing && processAlive(existing.pid)) {
    throw new Error(
      `[gpu-vision] a ${setKey} server is already running (pid ${existing.pid}, port ${existing.port}).\n` +
        "  Stop it first: node scripts/gpu-vision/serve.mjs --stop" +
        (setKey === "vlm" ? " --vlm" : ""),
    );
  }

  const port = requestedPort ?? (await findFreePort());
  const baseUrl = `http://127.0.0.1:${port}`;

  process.stdout.write(`[gpu-vision] launching ${set.label}\n`);
  process.stdout.write(
    `[gpu-vision]   llama-server build ${build}, parallel=${parallel}, ctx=${CONTEXT_SIZE}, port=${port}\n`,
  );

  const args = [
    "-m",
    modelPath,
    "--mmproj",
    mmprojPath,
    "-c",
    String(CONTEXT_SIZE),
    "--parallel",
    String(parallel),
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ];
  // The server is detached so it outlives this launcher, and its stdout/stderr
  // go to a log file rather than being inherited — inheriting the pipe would
  // keep this launcher's process alive after readiness, which is not what a
  // "start it and hand back the shell" command should do.
  const logPath = path.join(cacheDir(), `llama-server.${setKey}.log`);
  const logFd = openSync(logPath, "a");
  const child = spawn("llama-server", args, {
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();

  const startedAt = new Date().toISOString();
  state[setKey] = {
    port,
    pid: child.pid,
    model: set.files.model.name,
    repo: set.repo,
    revision: set.revision,
    logPath,
    startedAt,
  };
  await writeState(state);

  await waitForReady(`${baseUrl}/health`);

  process.stdout.write(`\n[gpu-vision] ${setKey} server ready\n`);
  process.stdout.write(`[gpu-vision]   base URL:      ${baseUrl}\n`);
  process.stdout.write(
    `[gpu-vision]   chat endpoint: ${baseUrl}/v1/chat/completions\n`,
  );
  process.stdout.write(`[gpu-vision]   pid:           ${child.pid}\n`);
  process.stdout.write(`[gpu-vision]   server log:    ${logPath}\n`);
  process.stdout.write(`[gpu-vision]   state file:    ${serveStatePath()}\n`);
  process.stdout.write(
    `[gpu-vision] stop with: node scripts/gpu-vision/serve.mjs --stop${setKey === "vlm" ? " --vlm" : ""}\n`,
  );
  // Exit explicitly so the launcher returns the shell; the server keeps running.
  process.exit(0);
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), {
    booleans: ["vlm", "stop"],
  });
  const setKey = flags.vlm ? "vlm" : "ocr";

  if (flags.stop) {
    await stop(setKey);
    return;
  }

  const parallel = flags.parallel ? Number(flags.parallel) : DEFAULT_PARALLEL;
  if (!Number.isInteger(parallel) || parallel < 1) {
    throw new Error(
      `[gpu-vision] --parallel must be a positive integer, got ${flags.parallel}`,
    );
  }
  const portSource = flags.port ?? process.env.ELIZA_GPU_VISION_PORT;
  const requestedPort = portSource ? Number(portSource) : undefined;
  if (
    requestedPort !== undefined &&
    (!Number.isInteger(requestedPort) ||
      requestedPort < 1 ||
      requestedPort > 65535)
  ) {
    throw new Error(
      `[gpu-vision] port must be a valid port, got ${portSource}`,
    );
  }

  await serve({ setKey, parallel, requestedPort });
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
