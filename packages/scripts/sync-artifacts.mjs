#!/usr/bin/env node
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
import { createWriteStream, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = join(ROOT, 'packages', 'scripts', 'artifacts-manifest.json');
const MARKER = join(ROOT, '.eliza-artifacts-version');
const log = (m) => console.log(`[sync-artifacts] ${m}`);
const warn = (m) => console.warn(`[sync-artifacts] WARNING: ${m}`);

if (process.env.ELIZA_SKIP_ARTIFACT_SYNC === '1') { log('skipped (ELIZA_SKIP_ARTIFACT_SYNC=1)'); process.exit(0); }
if (!existsSync(MANIFEST)) { log('no artifacts-manifest.json; nothing to sync'); process.exit(0); }

const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const { version, asset } = m;
if (existsSync(MARKER) && readFileSync(MARKER, 'utf8').trim() === version) {
  log(`artifacts already at ${version}; nothing to do`);
  process.exit(0);
}

const url = asset.url || `https://github.com/${asset.repo}/releases/download/${asset.tag}/${asset.name}`;
const tmp = join(tmpdir(), `eliza-artifacts-${process.pid}.tar.gz`);

async function download(dest) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      log(`downloading ${url} (attempt ${attempt}/4)`);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      return true;
    } catch (err) {
      warn(`download failed: ${err.message}`);
      try { rmSync(dest, { force: true }); } catch {}
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  return false;
}

function sha256(file) {
  const h = createHash('sha256');
  h.update(readFileSync(file));
  return h.digest('hex');
}

const ok = await download(tmp);
if (!ok) {
  warn(`could not download artifact bundle after retries.`);
  warn(`the repo is usable, but large fixtures/binaries are absent.`);
  warn(`retry later with:  bun run sync:artifacts`);
  process.exit(0);
}

if (asset.sha256) {
  const got = sha256(tmp);
  if (got !== asset.sha256) {
    warn(`sha256 mismatch (got ${got}, want ${asset.sha256}); not extracting.`);
    rmSync(tmp, { force: true });
    process.exit(0);
  }
}

log('extracting artifact bundle at repo root…');
// Prefer the Windows system bsdtar (System32\tar.exe): a GNU tar that may be
// first on PATH (Git-for-Windows / MSYS) misreads a `C:\...` archive path as an
// rsh `host:path` and dies with "Cannot connect to C: resolve failed". bsdtar
// (shipped with Windows 10 1803+/11) handles drive-letter paths natively.
// Like the download step above, never let extraction failure block `bun install`.
const tarBin =
  process.platform === 'win32'
    ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
try {
  execFileSync(tarBin, ['-xzf', tmp, '-C', ROOT], { stdio: 'inherit' });
  writeFileSync(MARKER, version + '\n');
  log(`done — artifacts synced to ${version}`);
} catch (err) {
  warn(`extraction failed: ${err.message}`);
  warn(`the repo is usable, but large fixtures/binaries are absent.`);
  warn(`retry later with:  bun run sync:artifacts`);
} finally {
  try { rmSync(tmp, { force: true }); } catch {}
}
