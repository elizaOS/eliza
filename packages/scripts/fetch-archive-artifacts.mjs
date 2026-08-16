#!/usr/bin/env node
/**
 * Explicit, opt-in downloader for the legacy elizaOS/eliza-archive artifact
 * bundle (large benchmark fixtures, CAD exports, media). It is deliberately
 * NOT wired into any install lifecycle: the old postinstall sync silently
 * extracted a ~1GB stale snapshot over the repository root and rewrote
 * tracked files (#16290). This script refuses to run from a package
 * lifecycle hook, fails closed with a non-zero exit and an actionable
 * message on download/digest/extraction problems, and never overwrites
 * git-tracked files — only paths untracked in the current checkout are
 * extracted.
 *
 *   bun run fetch:archive-artifacts        # deliberate operator invocation
 *
 * Test seams (integration tests only): ELIZA_ARCHIVE_URL,
 * ELIZA_ARCHIVE_SHA256, ELIZA_ARCHIVE_ROOT, ELIZA_ARCHIVE_MAX_ATTEMPTS.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = process.env.ELIZA_ARCHIVE_ROOT || DEFAULT_ROOT;
const MARKER = join(ROOT, ".eliza-artifacts-version");
const log = (m) => console.log(`[fetch-archive-artifacts] ${m}`);
const warn = (m) => console.warn(`[fetch-archive-artifacts] WARNING: ${m}`);
const fail = (lines) => {
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    console.error(`[fetch-archive-artifacts] ERROR: ${line}`);
  }
  process.exit(1);
};
const PROGRESS_INTERVAL_MS = 5000;
const STALE_TMP_MAX_AGE_MS = 6 * 60 * 60_000;

// Frozen coordinates of the legacy archive snapshot. The bundle is a
// point-in-time export; it is not updated with the repository, which is
// exactly why it must never run implicitly on install.
const ARCHIVE = {
  version: "2026-06-18.1",
  url:
    process.env.ELIZA_ARCHIVE_URL ||
    "https://github.com/elizaOS/eliza-archive/releases/download/dev-artifacts/eliza-dev-artifacts.tar.gz",
  sha256:
    process.env.ELIZA_ARCHIVE_SHA256 ||
    "f33042edcde955adfdcde1c1a98c62817d09e5f624f3b5b842aea7c4db975550",
  bytes: 1018170326,
  fileCount: 638,
};
const MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.ELIZA_ARCHIVE_MAX_ATTEMPTS) || 4,
);

// Refuse lifecycle invocation: this download is an operator decision, not an
// install side effect. bun/npm set npm_lifecycle_event for hook scripts.
const lifecycleEvent = process.env.npm_lifecycle_event;
if (
  lifecycleEvent &&
  /^(pre|post)?(install|prepare|prepublish)/.test(lifecycleEvent)
) {
  fail([
    `refusing to run from package lifecycle hook "${lifecycleEvent}".`,
    "The archive bundle is a stale snapshot and must never be pulled implicitly on install.",
    "Run it deliberately instead:  bun run fetch:archive-artifacts",
  ]);
}

// Sweep leaked partial downloads BEFORE any early exit; cancelled runs on
// shared runners previously filled /tmp with ~1GB partial archives.
cleanupStaleTempArchives();

if (
  existsSync(MARKER) &&
  readFileSync(MARKER, "utf8").trim() === ARCHIVE.version
) {
  log(`artifacts already at ${ARCHIVE.version}; nothing to do`);
  process.exit(0);
}

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
  const tempDirectory = tmpdir();
  let entries;
  try {
    entries = readdirSync(tempDirectory);
  } catch (err) {
    // error-policy:J6 best-effort temp cleanup; an unavailable temp directory must not block the fetch.
    warn(
      `could not enumerate artifact temp directory ${tempDirectory}: ${err.message}`,
    );
    return;
  }
  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (!/^eliza-artifacts-\d+\.tar\.gz$/.test(entry)) continue;
    const file = join(tempDirectory, entry);
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
      // error-policy:J6 best-effort temp cleanup; failed cleanup must not block the fetch.
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
      `artifact bundle size: ${formatBytes(totalBytes)} across ${ARCHIVE.fileCount} files`,
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
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      log(`downloading ${ARCHIVE.url} (attempt ${attempt}/${MAX_ATTEMPTS})`);
      const res = await fetch(ARCHIVE.url, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await streamToFileWithProgress(res, dest, ARCHIVE.bytes);
      return true;
    } catch (err) {
      warn(`download failed: ${err.message}`);
      try {
        rmSync(dest, { force: true });
      } catch {
        // error-policy:J6 best-effort teardown of the partial download before retrying.
      }
      if (attempt < MAX_ATTEMPTS)
        await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  return false;
}

function sha256(file) {
  const h = createHash("sha256");
  h.update(readFileSync(file));
  return h.digest("hex");
}

/** Returns the set of repository paths git currently tracks under ROOT. */
function trackedPaths() {
  const output = execFileSync("git", ["-C", ROOT, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return new Set(output.split("\0").filter(Boolean));
}

/** Lists archive member paths, normalized to repo-relative form. */
function archiveEntries(tarBin, archive) {
  const output = execFileSync(tarBin, ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return output
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^\.\//, ""));
}

const ok = await download(tmp);
if (!ok) {
  fail([
    `could not download the artifact bundle after ${MAX_ATTEMPTS} attempt(s): ${ARCHIVE.url}`,
    "Check network access to github.com and re-run:  bun run fetch:archive-artifacts",
  ]);
}

log(`verifying sha256 for ${formatBytes(ARCHIVE.bytes)} artifact bundle`);
const got = sha256(tmp);
if (got !== ARCHIVE.sha256) {
  rmSync(tmp, { force: true });
  fail([
    `sha256 mismatch (got ${got}, want ${ARCHIVE.sha256}); not extracting.`,
    "The published bundle may be corrupt or tampered with; re-run to retry the download.",
  ]);
}

// Prefer the Windows system bsdtar (System32\tar.exe): a GNU tar that may be
// first on PATH (Git-for-Windows / MSYS) misreads a `C:\...` archive path as an
// rsh `host:path` and dies with "Cannot connect to C: resolve failed". bsdtar
// (shipped with Windows 10 1803+/11) handles drive-letter paths natively.
const tarBin =
  process.platform === "win32"
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
try {
  // Never overwrite tracked files: the bundle is a stale snapshot and tracked
  // content is owned by git. Extract only members that are untracked in the
  // current checkout (directories are always safe to traverse).
  const tracked = trackedPaths();
  const entries = archiveEntries(tarBin, tmp);
  const skipped = [];
  const wanted = [];
  for (const entry of entries) {
    if (entry.endsWith("/")) continue;
    if (tracked.has(entry)) {
      skipped.push(entry);
    } else {
      wanted.push(entry);
    }
  }
  if (skipped.length > 0) {
    warn(
      `skipping ${skipped.length} archive member(s) that would overwrite git-tracked files (e.g. ${skipped[0]})`,
    );
  }
  if (wanted.length === 0) {
    log("no untracked archive members to extract");
  } else {
    const listDirectory = mkdtempSync(join(tmpdir(), "eliza-artifacts-list-"));
    const listFile = join(listDirectory, "members.txt");
    try {
      writeFileSync(listFile, `${wanted.join("\n")}\n`);
      log(
        `extracting ${wanted.length} untracked archive member(s) at repo root…`,
      );
      execFileSync(tarBin, ["-xzf", tmp, "-C", ROOT, "-T", listFile], {
        stdio: "inherit",
      });
    } finally {
      rmSync(listDirectory, { recursive: true, force: true });
    }
  }
  writeFileSync(MARKER, `${ARCHIVE.version}\n`);
  log(`done — artifacts synced to ${ARCHIVE.version}`);
} catch (err) {
  // fail() exits the process, which skips finally blocks — sweep the temp
  // bundle here so failed extractions do not leak ~1GB archives into /tmp.
  rmSync(tmp, { force: true });
  fail([
    `extraction failed: ${err.message}`,
    "The checkout was not marked as synced; fix the underlying problem and re-run:  bun run fetch:archive-artifacts",
  ]);
}
rmSync(tmp, { force: true });
