#!/usr/bin/env node
/**
 * Idempotent model fetcher for the local GPU vision service. Downloads the
 * pinned Unlimited-OCR GGUF + its F16 mmproj (and, under --with-vlm, a small
 * Qwen3-VL Instruct GGUF + mmproj) into the gpu-vision cache, verifies every
 * blob's sha256 against models.lock.json, and records the pin on first download.
 *
 * Fetch strategy: the `hf` CLI when present (resumable, revision-pinned),
 * otherwise a direct HTTPS `resolve/<revision>` download. Either way the integrity
 * gate is the same lockfile check — a corrupt or upstream-changed file fails loud
 * instead of being served. Already-present + verified files are skipped, so
 * re-running is cheap and safe.
 *
 * Usage:
 *   node scripts/gpu-vision/setup.mjs [--with-vlm]
 */

import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  assertPlausibleSize,
  cacheDir,
  formatBytes,
  lockKey,
  MODEL_SETS,
  modelFilePath,
  parseArgs,
  readLockfile,
  reconcileLock,
  sha256File,
  writeLockfile,
} from "./lib.mjs";

function hfCliPath() {
  for (const bin of ["hf", "huggingface-cli"]) {
    const probe = spawnSync(bin, ["version"], { encoding: "utf8" });
    if (probe.status === 0) return bin;
  }
  return null;
}

function resolveUrl(set, fileName) {
  return `https://huggingface.co/${set.repo}/resolve/${set.revision}/${fileName}`;
}

async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function downloadViaHf(hfBin, set, fileName, destDir) {
  const result = spawnSync(
    hfBin,
    [
      "download",
      set.repo,
      fileName,
      "--revision",
      set.revision,
      "--local-dir",
      destDir,
    ],
    { stdio: "inherit", encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `[gpu-vision] hf download failed for ${set.repo}/${fileName} (exit ${result.status})`,
    );
  }
  // hf places the file at destDir/<fileName>; our layout stores it flat there.
  return path.join(destDir, fileName);
}

async function downloadViaHttps(set, fileName, destPath) {
  const url = resolveUrl(set, fileName);
  process.stdout.write(`  GET ${url}\n`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`[gpu-vision] HTTP ${res.status} downloading ${url}`);
  }
  const tmp = `${destPath}.partial`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await fs.rename(tmp, destPath);
  return destPath;
}

/**
 * Ensure one pinned blob is present and lockfile-verified. Exported so the unit
 * suite can prove the skip-if-present path still runs the sha256 gate — a
 * present-but-wrong file must fail here, never be served.
 */
export async function ensureFile({ setKey, role, hfBin, lock }) {
  const set = MODEL_SETS[setKey];
  const file = set.files[role];
  const destPath = modelFilePath(setKey, role);
  const destDir = path.dirname(destPath);
  await fs.mkdir(destDir, { recursive: true });

  const key = lockKey(setKey, role);
  const pinned = lock[key];

  if (await fileExists(destPath)) {
    if (pinned) {
      const observedSha = await sha256File(destPath);
      reconcileLock(lock, key, { sha256: observedSha });
      const { size } = await fs.stat(destPath);
      process.stdout.write(
        `  skip  ${file.name} (present, sha256 verified, ${formatBytes(size)})\n`,
      );
      return { bytes: size, downloaded: false };
    }
    // Present but unpinned (first-ever run interrupted mid-record): re-hash and pin below.
  } else {
    process.stdout.write(
      `  fetch ${file.name} from ${set.repo}@${set.revision.slice(0, 8)}\n`,
    );
    if (hfBin) {
      const landed = await downloadViaHf(hfBin, set, file.name, destDir);
      if (landed !== destPath && (await fileExists(landed))) {
        await fs.rename(landed, destPath);
      }
    } else {
      await downloadViaHttps(set, file.name, destPath);
    }
  }

  // Cheap torn-download floor before the slower hash pass.
  const { size } = await fs.stat(destPath);
  assertPlausibleSize(size, file.approxBytes, file.name);

  const observedSha = await sha256File(destPath);
  const outcome = reconcileLock(lock, key, {
    sha256: observedSha,
    bytes: size,
    repo: set.repo,
    revision: set.revision,
    file: file.name,
    url: resolveUrl(set, file.name),
  });
  if (outcome.status === "recorded") {
    lock[key] = outcome.entry;
    process.stdout.write(
      `  WARN  recorded NEW pin for ${file.name} — review the models.lock.json diff before committing\n` +
        `        sha256=${observedSha} (${formatBytes(size)})\n`,
    );
  } else {
    process.stdout.write(
      `  ok    ${file.name} sha256 verified (${formatBytes(size)})\n`,
    );
  }
  return { bytes: size, downloaded: true };
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), {
    booleans: ["with-vlm"],
  });
  const sets = flags["with-vlm"] ? ["ocr", "vlm"] : ["ocr"];

  process.stdout.write(`[gpu-vision] cache: ${cacheDir()}\n`);
  process.stdout.write(`[gpu-vision] model sets: ${sets.join(", ")}\n`);

  const hfBin = hfCliPath();
  process.stdout.write(
    hfBin
      ? `[gpu-vision] using ${hfBin} for downloads\n`
      : "[gpu-vision] hf CLI not found; using direct HTTPS resolve URLs\n",
  );

  const lock = await readLockfile();
  let totalBytes = 0;
  let downloadedAny = false;

  for (const setKey of sets) {
    const set = MODEL_SETS[setKey];
    process.stdout.write(`\n[gpu-vision] ${set.label}\n`);
    for (const role of Object.keys(set.files)) {
      const { bytes, downloaded } = await ensureFile({
        setKey,
        role,
        hfBin,
        lock,
      });
      totalBytes += bytes;
      downloadedAny = downloadedAny || downloaded;
    }
  }

  await writeLockfile(lock);
  process.stdout.write(
    `\n[gpu-vision] done. total on disk: ${formatBytes(totalBytes)} across ${sets.length} set(s).\n`,
  );
  if (!downloadedAny) {
    process.stdout.write(
      "[gpu-vision] nothing to download — all files already present + verified.\n",
    );
  }
}

// Run only when invoked directly — the unit suite imports ensureFile from this
// module and must not trigger a download.
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}
