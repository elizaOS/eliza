#!/usr/bin/env node
/**
 * generate-contact-sheets.mjs
 *
 * Scans e2e-recordings/*\/test-results/ for Playwright test output,
 * extracts trace.zip files, copies non-blank frames to
 * e2e-recordings/contact-sheets/<package>/<test-slug>/frames/, and
 * writes e2e-recordings/manifest.json.
 *
 * Blank frames (uniform white/black — JPEG < 5 KB) are skipped.
 * No per-test HTML is generated; use generate-viewer.mjs for the index.
 *
 * Usage:
 *   node scripts/e2e-recordings/generate-contact-sheets.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RECORDINGS_DIR = path.join(REPO_ROOT, 'e2e-recordings');
const CONTACT_SHEETS_DIR = path.join(RECORDINGS_DIR, 'contact-sheets');
const MANIFEST_PATH = path.join(RECORDINGS_DIR, 'manifest.json');

// 500 = only filter corrupted/empty files; dark/sparse real frames can be 2-4 KB
const MIN_FRAME_BYTES = 500;

function toSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const INTERESTING_METHODS = new Set([
  'goto', 'click', 'fill', 'hover', 'press', 'check', 'uncheck',
  'selectOption', 'selectText', 'waitForSelector', 'waitForURL',
  'waitForLoadState', 'screenshot', 'tap', 'dblclick', 'dragTo',
  'dispatchEvent', 'setInputFiles', 'type',
]);

/**
 * Extract frames from a trace.zip.
 * Returns [{ screenshotSrc: string|null }, ...] with _tmpDir attached.
 */
function extractTraceFrames(zipPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-trace-'));
  try {
    const result = spawnSync('unzip', ['-q', '-o', zipPath, '-d', tmpDir], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      console.warn(`  [warn] unzip failed for ${zipPath}: ${result.stderr}`);
      return [];
    }

    const traceFiles = fs.existsSync(tmpDir)
      ? fs.readdirSync(tmpDir).filter((f) => /^\d+-trace\.trace$/.test(f)).sort()
      : [];

    if (traceFiles.length === 0) {
      console.warn(`  [warn] no *-trace.trace found in ${zipPath}`);
      return [];
    }

    const allEntries = [];
    for (const tf of traceFiles) {
      const lines = fs.readFileSync(path.join(tmpDir, tf), 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { allEntries.push(JSON.parse(trimmed)); } catch { /* skip */ }
      }
    }

    const screencasts = allEntries
      .filter((e) => e.type === 'screencast-frame' && e.sha1)
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

    const afterMap = new Map();
    for (const e of allEntries) {
      if (e.type === 'after' && e.callId) afterMap.set(e.callId, e);
    }

    const actions = allEntries.filter(
      (e) => e.type === 'before' && e.method && INTERESTING_METHODS.has(e.method),
    );

    const frames = [];
    for (const action of actions) {
      const afterEntry = afterMap.get(action.callId);
      const startTime = action.startTime ?? 0;
      const endTime = afterEntry?.endTime ?? startTime + 10000;
      // For goto actions, allow frames up to 2s after endTime for async renders
      const extendedEndTime = action.method === 'goto' ? endTime + 2000 : endTime;

      let bestFrame = null;
      for (let i = screencasts.length - 1; i >= 0; i--) {
        const f = screencasts[i];
        if ((f.timestamp ?? 0) <= extendedEndTime && (f.timestamp ?? 0) >= startTime) {
          bestFrame = f;
          break;
        }
      }
      if (!bestFrame) {
        bestFrame = screencasts.find((f) => (f.timestamp ?? 0) >= startTime) ?? null;
      }

      let screenshotSrc = null;
      if (bestFrame) {
        const candidate = path.join(tmpDir, 'resources', bestFrame.sha1);
        if (fs.existsSync(candidate)) screenshotSrc = candidate;
      }

      frames.push({ screenshotSrc });
    }

    // If no actions matched, fall back to first and last screencast frames
    if (frames.length === 0 && screencasts.length > 0) {
      const addFrame = (sc) => {
        const candidate = path.join(tmpDir, 'resources', sc.sha1);
        if (fs.existsSync(candidate)) frames.push({ screenshotSrc: candidate });
      };
      addFrame(screencasts[0]);
      if (screencasts.length > 1) addFrame(screencasts[screencasts.length - 1]);
    }

    frames._tmpDir = tmpDir;
    return frames;
  } catch (err) {
    console.warn(`  [warn] error extracting ${zipPath}: ${err.message}`);
    return [];
  }
}

function processTestDir(testResultDir, packageName) {
  const testDirName = path.basename(testResultDir);
  const slug = toSlug(testDirName);
  const outDir = path.join(CONTACT_SHEETS_DIR, packageName, slug);
  const framesDir = path.join(outDir, 'frames');

  const zipNames = fs
    .readdirSync(testResultDir)
    .filter((f) => /^trace(-\d+)?\.zip$/.test(f))
    .sort();

  const videoFiles = fs.readdirSync(testResultDir).filter((f) => f.endsWith('.webm'));
  const videoFile = videoFiles[0] ?? null;

  if (zipNames.length === 0 && !videoFile) return null;

  fs.mkdirSync(framesDir, { recursive: true });

  const copiedRelPaths = [];
  const tmpDirs = [];
  let frameIdx = 0;

  for (const zipName of zipNames) {
    const zipPath = path.join(testResultDir, zipName);
    const frames = extractTraceFrames(zipPath);
    if (frames._tmpDir) tmpDirs.push(frames._tmpDir);

    for (const frame of frames) {
      if (!frame.screenshotSrc) continue;

      // Skip uniform white/black flash frames
      try {
        const size = fs.statSync(frame.screenshotSrc).size;
        if (size < MIN_FRAME_BYTES) continue;
      } catch {
        continue;
      }

      const ext = path.extname(frame.screenshotSrc) || '.jpeg';
      const destName = `${String(frameIdx).padStart(4, '0')}${ext}`;
      const destPath = path.join(framesDir, destName);
      try {
        fs.copyFileSync(frame.screenshotSrc, destPath);
        const relOutDir = path.relative(RECORDINGS_DIR, outDir);
        copiedRelPaths.push(path.join(relOutDir, 'frames', destName));
        frameIdx++;
      } catch (err) {
        console.warn(`  [warn] could not copy frame: ${err.message}`);
      }
    }
  }

  for (const tmpDir of tmpDirs) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const relVideo = videoFile
    ? path.relative(RECORDINGS_DIR, path.join(testResultDir, videoFile))
    : null;

  return {
    name: testDirName,
    slug,
    package: packageName,
    resultDir: path.relative(RECORDINGS_DIR, testResultDir),
    video: relVideo,
    frameCount: copiedRelPaths.length,
    frames: copiedRelPaths,
  };
}

function findPackageDirs() {
  if (!fs.existsSync(RECORDINGS_DIR)) return [];
  return fs
    .readdirSync(RECORDINGS_DIR)
    .filter((name) => {
      if (name === 'contact-sheets' || name === 'manifest.json' || name === 'index.html') return false;
      const full = path.join(RECORDINGS_DIR, name);
      return fs.statSync(full).isDirectory();
    })
    .map((name) => ({ name, full: path.join(RECORDINGS_DIR, name) }));
}

function findTestResultDirs(packageRecordingDir) {
  const testResultsDir = path.join(packageRecordingDir, 'test-results');
  if (!fs.existsSync(testResultsDir)) return [];
  return fs
    .readdirSync(testResultsDir)
    .map((name) => path.join(testResultsDir, name))
    .filter((full) => fs.statSync(full).isDirectory());
}

async function main() {
  console.log('Scanning e2e-recordings for Playwright test output…');

  const packageDirs = findPackageDirs();
  if (packageDirs.length === 0) {
    console.log('No package recording directories found under e2e-recordings/');
    console.log('Expected structure: e2e-recordings/<package>/test-results/<test-dir>/');
    return;
  }

  const manifest = { generated: new Date().toISOString(), packages: {} };

  for (const { name: packageName, full: packageDir } of packageDirs) {
    console.log(`\nPackage: ${packageName}`);
    const testDirs = findTestResultDirs(packageDir);
    if (testDirs.length === 0) {
      console.log('  No test-results/ directory found.');
      continue;
    }

    const tests = [];
    for (const testDir of testDirs) {
      console.log(`  Processing: ${path.basename(testDir)}`);
      try {
        const meta = processTestDir(testDir, packageName);
        if (meta) {
          tests.push(meta);
          console.log(`    → ${meta.frameCount} real frames (blank frames filtered)`);
        } else {
          console.log('    → skipped (no trace or video)');
        }
      } catch (err) {
        console.warn(`  [error] ${testDir}: ${err.message}`);
      }
    }

    if (tests.length > 0) manifest.packages[packageName] = { tests };
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\nManifest written: ${MANIFEST_PATH}`);

  const totalTests = Object.values(manifest.packages).reduce(
    (sum, pkg) => sum + pkg.tests.length,
    0,
  );
  console.log(`Done. ${totalTests} test(s) processed across ${Object.keys(manifest.packages).length} package(s).`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
