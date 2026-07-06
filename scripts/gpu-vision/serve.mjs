#!/usr/bin/env node
/**
 * Launches and supervises a resident `llama-server` for the GPU vision lane. One
 * server holds the model in VRAM and serves an OpenAI-compatible endpoint with
 * `--parallel N` slots; the analyzer registry queues jobs against it rather than
 * loading a model per image. Serves Unlimited-OCR by default, or Qwen3-VL under
 * --vlm (a second instance keyed by model in the shared serve.json).
 *
 * serve.json is written only AFTER /health answers, so a discovery record always
 * points at a server that actually became ready — a fast crash (port collision,
 * corrupt gguf, OOM) is surfaced immediately by racing the child's exit against
 * the readiness poll, and the spawned child is torn down on any launch failure.
 * PIDs recycle, so both --stop and the already-running check verify the recorded
 * pid is really a llama-server (ps comm) before trusting it; stale entries are
 * discarded with a note, never obeyed.
 *
 * The DeepSeek-OCR mmproj needs llama.cpp >= b8525 (PR 17400, 2026-03-25); an
 * older or missing binary fails here with an actionable upgrade message rather
 * than a cryptic model-load error deep in the server.
 *
 * Usage:
 *   node scripts/gpu-vision/serve.mjs [--vlm] [--parallel N] [--port P] [--verify]
 *   node scripts/gpu-vision/serve.mjs --stop [--vlm]
 */

import { spawn, spawnSync } from "node:child_process";
import { openSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertLlamaBuildSupported,
  cacheDir,
  findFreePort,
  lockKey,
  MODEL_SETS,
  modelFilePath,
  parseArgs,
  parsePort,
  parsePositiveInteger,
  readLockfile,
  reconcileLock,
  serveStatePath,
  sha256File,
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
  return assertLlamaBuildSupported(
    `${probe.stdout || ""}${probe.stderr || ""}`,
  );
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
    // error-policy:J3 kill(pid, 0) throwing ESRCH/EPERM IS the "not ours/not
    // alive" answer this probe exists to produce, not a failure to hide.
    return false;
  }
}

/** PIDs recycle; before trusting a recorded pid, confirm the process it names
 * is actually a llama-server. `ps -o comm=` is portable across macOS/Linux. */
function pidIsLlamaServer(pid) {
  const probe = spawnSync("ps", ["-p", String(pid), "-o", "comm="], {
    encoding: "utf8",
  });
  if (probe.error || probe.status !== 0) return false;
  return probe.stdout.trim().toLowerCase().includes("llama-server");
}

function entryIsLive(entry) {
  return processAlive(entry.pid) && pidIsLlamaServer(entry.pid);
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
  if (!processAlive(entry.pid)) {
    process.stdout.write(
      `[gpu-vision] ${setKey} server pid ${entry.pid} already gone\n`,
    );
  } else if (!pidIsLlamaServer(entry.pid)) {
    process.stdout.write(
      `[gpu-vision] pid ${entry.pid} exists but is not a llama-server (pid recycled) — ` +
        "discarding stale serve.json entry without signaling\n",
    );
  } else {
    process.kill(entry.pid, "SIGTERM");
    process.stdout.write(
      `[gpu-vision] stopped ${setKey} server pid ${entry.pid} (port ${entry.port})\n`,
    );
  }
  delete state[setKey];
  await writeState(state);
}

/**
 * --verify: re-hash both blobs against models.lock.json before launch. Guards
 * against on-disk corruption/tampering between setup and serve at the cost of
 * hashing ~2.7 GiB; the default stays presence-only for boot speed.
 */
async function verifyBlobs(setKey) {
  const lock = await readLockfile();
  for (const role of ["model", "mmproj"]) {
    const key = lockKey(setKey, role);
    if (!lock[key]) {
      throw new Error(
        `[gpu-vision] --verify: no pin for ${key} in models.lock.json — run setup.mjs first`,
      );
    }
    const filePath = modelFilePath(setKey, role);
    const sha256 = await sha256File(filePath);
    reconcileLock(lock, key, { sha256 });
    process.stdout.write(
      `[gpu-vision]   verified ${path.basename(filePath)} sha256 ok\n`,
    );
  }
}

async function serve({ setKey, parallel, requestedPort, verify }) {
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
  if (verify) await verifyBlobs(setKey);

  const state = await readState();
  const existing = state[setKey];
  if (existing) {
    if (entryIsLive(existing)) {
      throw new Error(
        `[gpu-vision] a ${setKey} server is already running (pid ${existing.pid}, port ${existing.port}).\n` +
          "  Stop it first: node scripts/gpu-vision/serve.mjs --stop" +
          (setKey === "vlm" ? " --vlm" : ""),
      );
    }
    process.stdout.write(
      `[gpu-vision] discarding stale serve.json ${setKey} entry (pid ${existing.pid} is ` +
        `${processAlive(existing.pid) ? "not a llama-server — pid recycled" : "gone"})\n`,
    );
    delete state[setKey];
    await writeState(state);
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

  // Race readiness against the child dying: a fast crash (port collision,
  // corrupt gguf, OOM) fails immediately with a pointer at the log instead of
  // burning the full readiness timeout on ECONNREFUSED.
  const childExited = new Promise((_, reject) => {
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `[gpu-vision] llama-server exited ${signal ? `on signal ${signal}` : `with code ${code}`} ` +
            `before becoming ready — see ${logPath}`,
        ),
      );
    });
  });

  try {
    await Promise.race([waitForReady(`${baseUrl}/health`), childExited]);
  } catch (err) {
    if (processAlive(child.pid)) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // error-policy:J6 best-effort teardown — the child may exit between the
        // aliveness check and the signal; the launch failure below is the error.
      }
    }
    throw err;
  }
  // error-policy:J5 the childExited rejection is observed in the race above;
  // after readiness wins this promise must not surface as an unhandled rejection.
  childExited.catch(() => {});

  // Record discovery state only for a server that actually answered /health,
  // so the analyzer registry can never pick up a never-ready instance.
  state[setKey] = {
    port,
    pid: child.pid,
    model: set.files.model.name,
    repo: set.repo,
    revision: set.revision,
    logPath,
    startedAt: new Date().toISOString(),
  };
  await writeState(state);

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
    booleans: ["vlm", "stop", "verify"],
  });
  const setKey = flags.vlm ? "vlm" : "ocr";

  if (flags.stop) {
    await stop(setKey);
    return;
  }

  const parallel = parsePositiveInteger(
    flags.parallel,
    "--parallel",
    DEFAULT_PARALLEL,
  );
  const requestedPort =
    flags.port !== undefined
      ? parsePort(flags.port, "--port")
      : parsePort(process.env.ELIZA_GPU_VISION_PORT, "ELIZA_GPU_VISION_PORT");

  await serve({
    setKey,
    parallel,
    requestedPort,
    verify: flags.verify === true,
  });
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
