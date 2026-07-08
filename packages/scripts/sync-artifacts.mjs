#!/usr/bin/env node
// Drives repo automation sync artifacts with explicit CLI and CI behavior.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
/**
 * sync-artifacts.mjs
 *
 * Large generated / downloadable artifacts (benchmark fixtures, CAD exports,
 * build outputs, vendored binaries, media) are NOT committed to this repo —
 * they would make `git clone` slow and heavy. They live as a single bundle on
 * the elizaOS/eliza-archive release and are pulled here on install.
 *
 * This script is idempotent: it no-ops when the on-disk artifact version
 * already matches packages/scripts/artifacts-manifest.json.
 *
 *   bun packages/scripts/sync-artifacts.mjs        # used by postinstall
 *   ELIZA_SKIP_ARTIFACT_SYNC=1 ...                 # skip (CI lanes that don't need them)
 *
 * On download failure it warns and exits 0 so a network blip never blocks
 * `bun install`; re-run `bun run sync:artifacts` to retry.
 */
import {
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = join(ROOT, "packages", "scripts", "artifacts-manifest.json");
const MARKER = join(ROOT, ".eliza-artifacts-version");
const log = (m) => console.log(`[sync-artifacts] ${m}`);
const warn = (m) => console.warn(`[sync-artifacts] WARNING: ${m}`);
const PROGRESS_INTERVAL_MS = 5000;
const STALE_TMP_MAX_AGE_MS = 6 * 60 * 60_000;

if (process.env.ELIZA_SKIP_ARTIFACT_SYNC === "1") {
  log("skipped (ELIZA_SKIP_ARTIFACT_SYNC=1)");
  process.exit(0);
}
if (!existsSync(MANIFEST)) {
  log("no artifacts-manifest.json; nothing to sync");
  process.exit(0);
}

const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
const { version, asset } = m;
cleanupStaleTempArchives();

if (existsSync(MARKER) && readFileSync(MARKER, "utf8").trim() === version) {
  log(`artifacts already at ${version}; nothing to do`);
  process.exit(0);
}

const url =
  asset.url ||
  `https://github.com/${asset.repo}/releases/download/${asset.tag}/${asset.name}`;
const tmp = join(tmpdir(), `eliza-artifacts-${process.pid}.tar.gz`);

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  return `${value >= 10 || unit === "B" ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function progressStatus(received, total, startedAt) {
  const elapsedMs = Math.max(Date.now() - startedAt, 1);
  const bytesPerSecond = received / (elapsedMs / 1000);
  const parts = [`downloaded ${formatBytes(received)}`];
  if (total > 0) {
    const percent = Math.min((received / total) * 100, 100);
    const remainingBytes = Math.max(total - received, 0);
    const etaMs =
      bytesPerSecond > 0 ? (remainingBytes / bytesPerSecond) * 1000 : NaN;
    parts.push(
      `of ${formatBytes(total)}`,
      `(${percent.toFixed(1)}%)`,
      `eta ${formatDuration(etaMs)}`,
    );
  }
  parts.push(`at ${formatBytes(bytesPerSecond)}/s`);
  return parts.join(" ");
}

function cleanupStaleTempArchives() {
  const now = Date.now();
  let removed = 0;
  for (const entry of readdirSync(tmpdir())) {
    if (!/^eliza-artifacts-\d+\.tar\.gz$/.test(entry)) continue;
    const file = join(tmpdir(), entry);
    let stat;
    try {
      stat = statSync(file);
    } catch (err) {
      // error-policy:J6 best-effort temp cleanup; a racing process may remove the file first.
      warn(`could not stat stale temp archive ${file}: ${err.message}`);
      continue;
    }
    if (!stat.isFile()) continue;
    if (now - stat.mtimeMs < STALE_TMP_MAX_AGE_MS) continue;
    try {
      rmSync(file, { force: true });
      removed += 1;
    } catch (err) {
      // error-policy:J6 best-effort temp cleanup; failed cleanup must not block install.
      warn(`could not remove stale temp archive ${file}: ${err.message}`);
    }
  }
  if (removed > 0) {
    log(
      `removed ${removed} stale artifact temp archive${removed === 1 ? "" : "s"}`,
    );
  }
}

async function streamToFileWithProgress(response, dest, expectedBytes) {
  const headerBytes = Number(response.headers.get("content-length")) || 0;
  const totalBytes = headerBytes || expectedBytes || 0;
  const writer = createWriteStream(dest);
  const reader = response.body.getReader();
  const startedAt = Date.now();
  let received = 0;
  let lastLogAt = startedAt;
  let writerError;
  const streamError = new Promise((resolve) => {
    writer.once("error", (err) => {
      writerError = err;
      resolve();
    });
  });

  if (totalBytes > 0) {
    log(
      `artifact bundle size: ${formatBytes(totalBytes)}${m.fileCount ? ` across ${m.fileCount} files` : ""}`,
    );
  } else {
    log(
      "artifact bundle size unknown; reporting downloaded bytes until complete",
    );
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (!writer.write(value)) {
        await Promise.race([once(writer, "drain"), streamError]);
        if (writerError) throw writerError;
      }
      const now = Date.now();
      if (now - lastLogAt >= PROGRESS_INTERVAL_MS) {
        log(progressStatus(received, totalBytes, startedAt));
        lastLogAt = now;
      }
    }
  } finally {
    reader.releaseLock();
  }

  await Promise.race([
    new Promise((resolve, reject) => {
      writer.end((err) => (err ? reject(err) : resolve()));
    }),
    streamError,
  ]);
  if (writerError) throw writerError;
  log(`download complete: ${progressStatus(received, totalBytes, startedAt)}`);
}

async function download(dest) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      log(`downloading ${url} (attempt ${attempt}/4)`);
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await streamToFileWithProgress(res, dest, Number(asset.bytes) || 0);
      return true;
    } catch (err) {
      warn(`download failed: ${err.message}`);
      try {
        rmSync(dest, { force: true });
      } catch {}
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  return false;
}

function sha256(file) {
  const h = createHash("sha256");
  h.update(readFileSync(file));
  return h.digest("hex");
}

const ok = await download(tmp);
if (!ok) {
  warn(`could not download artifact bundle after retries.`);
  warn(`the repo is usable, but large fixtures/binaries are absent.`);
  warn(`retry later with:  bun run sync:artifacts`);
  process.exit(0);
}

if (asset.sha256) {
  log(`verifying sha256 for ${formatBytes(asset.bytes || 0)} artifact bundle`);
  const got = sha256(tmp);
  if (got !== asset.sha256) {
    warn(`sha256 mismatch (got ${got}, want ${asset.sha256}); not extracting.`);
    rmSync(tmp, { force: true });
    process.exit(0);
  }
}

log(
  `extracting artifact bundle at repo root${m.fileCount ? ` (${m.fileCount} files)` : ""}…`,
);
// Prefer the Windows system bsdtar (System32\tar.exe): a GNU tar that may be
// first on PATH (Git-for-Windows / MSYS) misreads a `C:\...` archive path as an
// rsh `host:path` and dies with "Cannot connect to C: resolve failed". bsdtar
// (shipped with Windows 10 1803+/11) handles drive-letter paths natively.
// Like the download step above, never let extraction failure block `bun install`.
const tarBin =
  process.platform === "win32"
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
try {
  execFileSync(tarBin, ["-xzf", tmp, "-C", ROOT], { stdio: "inherit" });
  writeFileSync(MARKER, `${version}\n`);
  log(`done — artifacts synced to ${version}`);
} catch (err) {
  warn(`extraction failed: ${err.message}`);
  warn(`the repo is usable, but large fixtures/binaries are absent.`);
  warn(`retry later with:  bun run sync:artifacts`);
} finally {
  try {
    rmSync(tmp, { force: true });
  } catch {}
}
