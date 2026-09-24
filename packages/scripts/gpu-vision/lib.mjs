/**
 * Shared pure logic for the local GPU vision service scripts (setup/serve/smoke).
 * These scripts stand up a resident `llama-server` for Baidu Unlimited-OCR (and
 * optionally Qwen3-VL) so the evidence analyzer registry (#14541/#14543) can hit
 * one OpenAI-compatible endpoint instead of loading a model per job. This module
 * holds the filesystem/version/lockfile/poller pieces that have no side effects
 * of their own so they can be unit-tested against stubs; the .mjs entrypoints
 * own the actual downloads, process launch, and HTTP requests.
 *
 * Model identity — repo id, revision, and exact filenames — is pinned here so a
 * silent upstream re-quant can never change what we serve without a code change.
 * The observed sha256/size of each blob lives in the checked-in models.lock.json
 * next to this file; the first real download records it, every later run
 * verifies against it and fails loud on drift (no fabricated success).
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LOCKFILE_PATH = path.join(__dirname, "models.lock.json");

/**
 * llama.cpp gained DeepSeek-OCR family support in PR 17400, merged 2026-03-25;
 * the first tagged release containing it is build b8525. Unlimited-OCR is a
 * DeepSeek-OCR derivative, so an older `llama-server` will refuse or mis-load
 * the mmproj. serve.mjs enforces this floor via assertLlamaBuildSupported.
 */
export const MIN_LLAMA_BUILD = 8525;

/**
 * Pinned model set. `ocr` is always fetched; `vlm` only under --with-vlm.
 * `approxBytes` is the exact blob size observed at pin time, used as a
 * torn-download floor (assertPlausibleSize) before the slower sha256 pass; the
 * authoritative integrity check is the sha256 in the lockfile. Revisions are the
 * commit shas observed on the HF repos so we pin to an immutable snapshot rather
 * than a moving branch head.
 */
export const MODEL_SETS = {
  ocr: {
    key: "ocr",
    label: "Baidu Unlimited-OCR (DeepSeek-OCR 3B, Q4_K_M)",
    repo: "sahilchachra/Unlimited-OCR-GGUF",
    revision: "0dc781d8a23f52963918ebd5b2d1b9fe61504661",
    files: {
      model: { name: "Unlimited-OCR-Q4_K_M.gguf", approxBytes: 1950326784 },
      mmproj: { name: "mmproj-Unlimited-OCR-F16.gguf", approxBytes: 811876448 },
    },
  },
  vlm: {
    key: "vlm",
    label: "Qwen3-VL-4B-Instruct (Q4_K_M)",
    repo: "Qwen/Qwen3-VL-4B-Instruct-GGUF",
    revision: "1cd86afb9a95c410a6038ab3b40d8b578c892266",
    files: {
      model: {
        name: "Qwen3VL-4B-Instruct-Q4_K_M.gguf",
        approxBytes: 2497281664,
      },
      mmproj: {
        name: "mmproj-Qwen3VL-4B-Instruct-F16.gguf",
        approxBytes: 836180256,
      },
    },
  },
};

/** Maximum tolerated deviation between a blob's on-disk size and its pinned
 * approxBytes before the download is rejected as torn/truncated. */
export const SIZE_TOLERANCE = 0.05;

/**
 * Torn-download floor: reject a blob whose size deviates grossly from the
 * pinned size before the (much slower) sha256 pass, so a truncated mirror
 * response gets a friendly early error instead of a bare hash mismatch.
 */
export function assertPlausibleSize(bytes, approxBytes, name) {
  const deviation = Math.abs(bytes - approxBytes) / approxBytes;
  if (deviation > SIZE_TOLERANCE) {
    throw new Error(
      `[gpu-vision] ${name} is ${formatBytes(bytes)} on disk but ~${formatBytes(approxBytes)} was expected ` +
        `(> ${SIZE_TOLERANCE * 100}% off) — the download looks truncated or the upstream blob changed. ` +
        "Delete the file and re-run setup.",
    );
  }
}

/** Grounding OCR prompt sent to the server at temp 0. The analyzer registry uses
 * this exact string so its OCR output is reproducible across runs. */
export const OCR_PROMPT =
  "Convert this document image to markdown. Transcribe every visible character exactly, preserving reading order. Output only the transcribed text with no commentary.";

/** Resolve the on-disk cache root. `ELIZA_GPU_VISION_CACHE` wins so CI/vast runs
 * can redirect to a scratch volume; otherwise the conventional per-user cache. */
export function cacheDir() {
  const override = process.env.ELIZA_GPU_VISION_CACHE;
  if (override?.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), ".cache", "eliza", "gpu-vision");
}

export function serveStatePath() {
  return path.join(cacheDir(), "serve.json");
}

/** Absolute path a given model set's file lands at once downloaded. */
export function modelFilePath(setKey, role) {
  const set = MODEL_SETS[setKey];
  if (!set) throw new Error(`[gpu-vision] unknown model set: ${setKey}`);
  const file = set.files[role];
  if (!file) throw new Error(`[gpu-vision] unknown file role: ${role}`);
  return path.join(cacheDir(), setKey, file.name);
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function readLockfile() {
  try {
    const raw = await fs.readFile(LOCKFILE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    // A present-but-corrupt lockfile is a real fault, not an empty one: surface it.
    throw new Error(
      `[gpu-vision] models.lock.json is unreadable: ${err.message}`,
    );
  }
}

export async function writeLockfile(lock) {
  const sorted = {};
  for (const key of Object.keys(lock).sort()) sorted[key] = lock[key];
  await fs.writeFile(
    LOCKFILE_PATH,
    `${JSON.stringify(sorted, null, 2)}\n`,
    "utf8",
  );
}

/** Stable lockfile identity for one blob: which repo revision and file it is. */
export function lockKey(setKey, role) {
  const set = MODEL_SETS[setKey];
  const file = set.files[role];
  return `${set.repo}@${set.revision}/${file.name}`;
}

/**
 * Compare a freshly-hashed blob against the lockfile. Returns one of:
 *   { status: "recorded", entry }  — no prior pin; caller should record it
 *   { status: "verified", entry }  — hash matches the pin
 * Throws on mismatch. This is the fail-loud integrity gate: a corrupt or
 * swapped download can never masquerade as the pinned model.
 */
export function reconcileLock(lock, key, observed) {
  const existing = lock[key];
  if (!existing) return { status: "recorded", entry: observed };
  if (existing.sha256 !== observed.sha256) {
    throw new Error(
      `[gpu-vision] sha256 mismatch for ${key}\n` +
        `  expected ${existing.sha256}\n` +
        `  observed ${observed.sha256}\n` +
        "  The download is corrupt or the upstream file changed. Delete the cached " +
        "file and re-run; if upstream legitimately changed, update models.lock.json deliberately.",
    );
  }
  return { status: "verified", entry: existing };
}

/**
 * Parse the build number out of `llama-server --version` output. The first line
 * is `version: <build> (<shorthash>)`; we key the version gate on the monotonic
 * build integer rather than the commit hash. Returns null when unparseable.
 */
export function parseLlamaBuild(versionOutput) {
  const match = /version:\s*(\d+)/i.exec(versionOutput ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * The DeepSeek-OCR version gate: throws with an actionable upgrade message when
 * the `--version` output is unparseable or the build predates b8525, otherwise
 * returns the build number. Pure so the boundary (b8524 rejected / b8525
 * accepted) is unit-testable without spawning a binary.
 */
export function assertLlamaBuildSupported(versionOutput) {
  const build = parseLlamaBuild(versionOutput);
  if (build === null) {
    throw new Error(
      `[gpu-vision] could not parse llama-server version from:\n${versionOutput}`,
    );
  }
  if (build < MIN_LLAMA_BUILD) {
    throw new Error(
      `[gpu-vision] llama-server build ${build} is too old for DeepSeek-OCR models.\n` +
        `  Need build >= ${MIN_LLAMA_BUILD} (PR 17400, merged 2026-03-25).\n` +
        "  Upgrade: `brew upgrade llama.cpp`.",
    );
  }
  return build;
}

/**
 * Validate a TCP port from a flag or env var. Returns undefined for absent or
 * empty input; throws on anything that is not an integer in 1-65535 so a typo'd
 * port can never silently become `http://127.0.0.1:NaN`.
 */
export function parsePort(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") {
    throw new Error(`[gpu-vision] ${label} requires a port number`);
  }
  if (String(value).trim() === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `[gpu-vision] ${label} must be an integer port 1-65535, got ${value}`,
    );
  }
  return port;
}

/** Validate a positive integer CLI/env value. Bare value flags parse as boolean
 * true, which must be rejected instead of becoming Number(true) === 1. */
export function parsePositiveInteger(value, label, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    throw new Error(`[gpu-vision] ${label} requires a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `[gpu-vision] ${label} must be a positive integer, got ${value}`,
    );
  }
  return parsed;
}

/** Human-readable byte formatter for the setup/serve reports. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(2)} GiB`;
  const mib = bytes / 1024 ** 2;
  return `${mib.toFixed(1)} MiB`;
}

/**
 * Minimal flag parser shared by the entrypoints. Recognises `--flag`,
 * `--key value`, and `--key=value`; everything else becomes a positional. Kept
 * deliberately tiny — these scripts have a handful of options and pulling in a
 * CLI framework would be more surface than the whole feature.
 */
export function parseArgs(argv, { booleans = [] } = {}) {
  const booleanSet = new Set(booleans);
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (booleanSet.has(body)) {
      flags[body] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return { flags, positionals };
}

/** Ask the OS for a free TCP port by binding :0 and reading back the assignment.
 * Used only when no explicit port is requested — never hardcode a busy port. */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Poll a readiness URL until it answers 200 or the deadline passes. `fetchImpl`
 * is injectable so the poller is testable against a stub server without touching
 * global fetch. Each probe carries its own abort timeout so a socket that
 * accepts but never responds cannot hang the poll (or a smoke run) forever.
 * Returns true on ready; throws with elapsed time on timeout so a
 * hung/mis-launched server surfaces as a hard failure rather than a silent hang.
 */
export async function waitForReady(
  url,
  {
    timeoutMs = 120000,
    intervalMs = 500,
    probeTimeoutMs = 3000,
    fetchImpl = fetch,
  } = {},
) {
  const start = Date.now();
  let lastError = "no response";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      if (res.ok) return true;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  throw new Error(
    `[gpu-vision] server not ready at ${url} after ${elapsed}s (last: ${lastError})`,
  );
}
