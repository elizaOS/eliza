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
 * Failure handling is throw-based: every fail path raises and is translated
 * once at the process boundary, so the `finally` sweep of the ~1GB temp
 * archive is unconditional. The digest is computed incrementally while the
 * download streams to disk (never buffering the bundle in memory), and every
 * archive member name is validated as a safe repo-relative path before any
 * name reaches tar — option-like, absolute, drive-letter, `..`, or
 * control-character members abort the run without extracting anything.
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
const PROGRESS_INTERVAL_MS = 5000;
const STALE_TMP_MAX_AGE_MS = 6 * 60 * 60_000;

/** Terminal failure carrying the operator-facing message lines. */
class FetchArtifactsFailure extends Error {
  constructor(lines) {
    const list = Array.isArray(lines) ? lines : [lines];
    super(list[0]);
    this.name = "FetchArtifactsFailure";
    this.lines = list;
  }
}

// Throws instead of exiting so the boundary `finally` always sweeps the temp
// archive; process.exit here would skip cleanup and leak ~1GB into /tmp.
const fail = (lines) => {
  throw new FetchArtifactsFailure(lines);
};

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

/**
 * Streams the response body to `dest`, updating `hash` with every chunk so
 * the digest never requires re-reading (or buffering) the ~1GB bundle.
 */
async function streamToFileWithProgress(response, dest, expectedBytes, hash) {
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
      hash.update(value);
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

/** Downloads to `dest`; returns the streamed sha256 hex digest, or null. */
async function download(dest) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      log(`downloading ${ARCHIVE.url} (attempt ${attempt}/${MAX_ATTEMPTS})`);
      const res = await fetch(ARCHIVE.url, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const hash = createHash("sha256");
      await streamToFileWithProgress(res, dest, ARCHIVE.bytes, hash);
      return hash.digest("hex");
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
  return null;
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

/**
 * Members that must never reach tar: option-like names (GNU tar interprets
 * `-`-prefixed lines in a -T list as options), absolute or drive-letter
 * paths, backslashes, `..` traversal segments, and control characters.
 */
function findUnsafeArchiveMembers(entries) {
  return entries.filter(
    (entry) =>
      entry.startsWith("/") ||
      entry.startsWith("-") ||
      entry.includes("\\") ||
      /^[A-Za-z]:/.test(entry) ||
      entry.split("/").includes("..") ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
      /[\u0000-\u001f\u007f]/.test(entry),
  );
}

async function main() {
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

  // Sweep leaked partial downloads BEFORE any early return; cancelled runs on
  // shared runners previously filled /tmp with ~1GB partial archives.
  cleanupStaleTempArchives();

  if (
    existsSync(MARKER) &&
    readFileSync(MARKER, "utf8").trim() === ARCHIVE.version
  ) {
    log(`artifacts already at ${ARCHIVE.version}; nothing to do`);
    return;
  }

  const digest = await download(tmp);
  if (digest === null) {
    fail([
      `could not download the artifact bundle after ${MAX_ATTEMPTS} attempt(s): ${ARCHIVE.url}`,
      "Check network access to github.com and re-run:  bun run fetch:archive-artifacts",
    ]);
  }

  if (digest !== ARCHIVE.sha256) {
    fail([
      `sha256 mismatch (got ${digest}, want ${ARCHIVE.sha256}); not extracting.`,
      "The published bundle may be corrupt or tampered with; re-run to retry the download.",
    ]);
  }
  log(`sha256 verified for ${formatBytes(ARCHIVE.bytes)} artifact bundle`);

  // Prefer the Windows system bsdtar (System32\tar.exe): a GNU tar that may be
  // first on PATH (Git-for-Windows / MSYS) misreads a `C:\...` archive path as an
  // rsh `host:path` and dies with "Cannot connect to C: resolve failed". bsdtar
  // (shipped with Windows 10 1803+/11) handles drive-letter paths natively.
  const tarBin =
    process.platform === "win32"
      ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "tar";
  try {
    const entries = archiveEntries(tarBin, tmp);
    const unsafe = findUnsafeArchiveMembers(entries);
    if (unsafe.length > 0) {
      fail([
        `refusing to extract: ${unsafe.length} archive member(s) have unsafe paths (e.g. ${JSON.stringify(unsafe[0])}).`,
        "Member names must be repo-relative; option-like, absolute, `..`, or control-character paths are rejected.",
        "The published bundle may be corrupt or tampered with; nothing was extracted.",
      ]);
    }

    // Never overwrite tracked files: the bundle is a stale snapshot and tracked
    // content is owned by git. Extract only members that are untracked in the
    // current checkout (directories are always safe to traverse).
    const tracked = trackedPaths();
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
      const listDirectory = mkdtempSync(
        join(tmpdir(), "eliza-artifacts-list-"),
      );
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
    if (err instanceof FetchArtifactsFailure) throw err;
    // error-policy:J2 context-adding rethrow: extraction errors become the operator-facing failure.
    fail([
      `extraction failed: ${err.message}`,
      "The checkout was not marked as synced; fix the underlying problem and re-run:  bun run fetch:archive-artifacts",
    ]);
  }
}

try {
  await main();
} catch (err) {
  // error-policy:J1 boundary translation: the CLI prints actionable errors and exits non-zero.
  const lines =
    err instanceof FetchArtifactsFailure
      ? err.lines
      : [`unexpected failure: ${err.message}`];
  for (const line of lines) {
    console.error(`[fetch-archive-artifacts] ERROR: ${line}`);
  }
  process.exitCode = 1;
} finally {
  // Unconditional: no failure path may leak the ~1GB temp bundle.
  rmSync(tmp, { force: true });
}
