#!/usr/bin/env node
/**
 * generate-contact-sheets.mjs
 *
 * Scans e2e-recordings/*\/test-results/ for Playwright test output,
 * extracts trace.zip files, and generates per-test HTML contact sheets
 * plus a manifest.json summarizing all tests.
 *
 * Usage:
 *   node scripts/e2e-recordings/generate-contact-sheets.mjs
 *
 * Output:
 *   e2e-recordings/contact-sheets/<package>/<test-slug>/frames/   PNG screenshots
 *   e2e-recordings/contact-sheets/<package>/<test-slug>/contact-sheet.html
 *   e2e-recordings/manifest.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo root is two levels up from scripts/e2e-recordings/
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RECORDINGS_DIR = path.join(REPO_ROOT, 'e2e-recordings');
const CONTACT_SHEETS_DIR = path.join(RECORDINGS_DIR, 'contact-sheets');
const MANIFEST_PATH = path.join(RECORDINGS_DIR, 'manifest.json');

/** Convert a test directory name to a URL-safe slug. */
function toSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Summarise action params into a short human-readable label. */
function summariseParams(apiName, params) {
  if (!params) return '';
  try {
    if (apiName === 'page.goto') return params.url ?? '';
    if (apiName === 'page.click' || apiName === 'locator.click') {
      return params.selector ?? params.expression ?? '';
    }
    if (apiName === 'page.fill' || apiName === 'locator.fill') {
      const sel = params.selector ?? params.expression ?? '';
      const val = params.value != null ? ` = "${String(params.value).slice(0, 40)}"` : '';
      return `${sel}${val}`;
    }
    if (apiName === 'page.hover' || apiName === 'locator.hover') {
      return params.selector ?? params.expression ?? '';
    }
    // Fallback: first string value in params
    for (const v of Object.values(params)) {
      if (typeof v === 'string') return v.slice(0, 60);
    }
  } catch {
    // ignore
  }
  return '';
}

/** Return the CSS background colour for an action label chip. */
function actionColor(apiName) {
  if (!apiName) return '#555';
  const lc = apiName.toLowerCase();
  if (lc.includes('goto')) return '#1a5276';
  if (lc.includes('click')) return '#7d4e00';
  if (lc.includes('fill') || lc.includes('type')) return '#145a32';
  if (lc.includes('hover')) return '#4a235a';
  return '#2c3e50';
}

// Action methods worth showing in the contact sheet
const INTERESTING_METHODS = new Set([
  'goto', 'click', 'fill', 'hover', 'press', 'check', 'uncheck',
  'selectOption', 'selectText', 'waitForSelector', 'waitForURL',
  'waitForLoadState', 'screenshot', 'tap', 'dblclick', 'dragTo',
  'dispatchEvent', 'setInputFiles', 'type',
]);

/**
 * Extract a trace.zip and return an array of action frames:
 * [{ apiName, params, screenshotSrc }]
 *
 * Playwright 1.60 trace format:
 *  - Main trace: 0-trace.trace (JSON lines)
 *  - Screenshots: screencast-frame entries referencing resources/<sha1> JPEG files
 *  - Actions: before/after pairs correlated by callId
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

    // Find the main trace file: 0-trace.trace, 1-trace.trace, etc.
    const traceFiles = fs.existsSync(tmpDir)
      ? fs.readdirSync(tmpDir).filter((f) => /^\d+-trace\.trace$/.test(f)).sort()
      : [];

    if (traceFiles.length === 0) {
      console.warn(`  [warn] no *-trace.trace found in ${zipPath}`);
      return [];
    }

    // Parse all JSON lines from all trace files
    const allEntries = [];
    for (const tf of traceFiles) {
      const lines = fs.readFileSync(path.join(tmpDir, tf), 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          allEntries.push(JSON.parse(trimmed));
        } catch {
          // skip malformed lines
        }
      }
    }

    // Collect screencast frames sorted by timestamp
    const screencasts = allEntries
      .filter((e) => e.type === 'screencast-frame' && e.sha1)
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

    // Build endTime map from 'after' entries
    const afterMap = new Map();
    for (const e of allEntries) {
      if (e.type === 'after' && e.callId) afterMap.set(e.callId, e);
    }

    // Collect interesting 'before' entries
    const actions = allEntries.filter((e) => {
      if (e.type !== 'before') return false;
      if (!e.method) return false;
      if (!INTERESTING_METHODS.has(e.method)) return false;
      return true;
    });

    const frames = [];
    for (const action of actions) {
      const afterEntry = afterMap.get(action.callId);
      const startTime = action.startTime ?? 0;
      const endTime = afterEntry?.endTime ?? startTime + 10000;

      // Prefer the last screencast-frame that falls within [startTime, endTime]
      let bestFrame = null;
      for (let i = screencasts.length - 1; i >= 0; i--) {
        const f = screencasts[i];
        if ((f.timestamp ?? 0) <= endTime && (f.timestamp ?? 0) >= startTime) {
          bestFrame = f;
          break;
        }
      }
      // Fallback: first frame after startTime
      if (!bestFrame) {
        bestFrame = screencasts.find((f) => (f.timestamp ?? 0) >= startTime) ?? null;
      }

      let screenshotSrc = null;
      if (bestFrame) {
        const candidate = path.join(tmpDir, 'resources', bestFrame.sha1);
        if (fs.existsSync(candidate)) screenshotSrc = candidate;
      }

      // Build a human-readable apiName from class + method
      const apiName = action.class
        ? `${action.class.toLowerCase()}.${action.method}`
        : action.method;

      frames.push({ apiName, params: action.params ?? {}, screenshotSrc });
    }

    // If no actions matched but we have screencast frames, include first/last
    if (frames.length === 0 && screencasts.length > 0) {
      const addFrame = (sc) => {
        const candidate = path.join(tmpDir, 'resources', sc.sha1);
        if (fs.existsSync(candidate)) {
          frames.push({ apiName: '(screencast frame)', params: {}, screenshotSrc: candidate });
        }
      };
      addFrame(screencasts[0]);
      if (screencasts.length > 1) addFrame(screencasts[screencasts.length - 1]);
    }

    // Store tmpDir on the array so processTestDir can clean up after copying
    frames._tmpDir = tmpDir;
    return frames;
  } catch (err) {
    console.warn(`  [warn] error extracting ${zipPath}: ${err.message}`);
    return [];
  }
}

/**
 * Process one test result directory.
 * Returns test metadata or null if nothing useful was found.
 */
function processTestDir(testResultDir, packageName) {
  const testDirName = path.basename(testResultDir);
  const slug = toSlug(testDirName);
  const outDir = path.join(CONTACT_SHEETS_DIR, packageName, slug);
  const framesDir = path.join(outDir, 'frames');

  // Find trace zip(s): trace.zip, trace-1.zip, …
  const zipNames = fs
    .readdirSync(testResultDir)
    .filter((f) => /^trace(-\d+)?\.zip$/.test(f))
    .sort();

  // Find video
  const videoFiles = fs
    .readdirSync(testResultDir)
    .filter((f) => f.endsWith('.webm'));
  const videoFile = videoFiles[0] ?? null;

  if (zipNames.length === 0 && !videoFile) {
    return null; // nothing to process
  }

  fs.mkdirSync(framesDir, { recursive: true });

  // Collect all frames across all zips
  const allFrames = [];
  const tmpDirs = [];

  for (const zipName of zipNames) {
    const zipPath = path.join(testResultDir, zipName);
    const frames = extractTraceFrames(zipPath);
    if (frames._tmpDir) tmpDirs.push(frames._tmpDir);

    for (const frame of frames) {
      if (frame.screenshotSrc) {
        const idx = String(allFrames.length).padStart(4, '0');
        // Preserve the original extension (may be .jpeg, .png, etc.)
        const ext = path.extname(frame.screenshotSrc) || '.jpeg';
        const destName = `${idx}${ext}`;
        const destPath = path.join(framesDir, destName);
        try {
          fs.copyFileSync(frame.screenshotSrc, destPath);
          frame.localPath = destName; // relative to framesDir
        } catch (err) {
          console.warn(`  [warn] could not copy frame: ${err.message}`);
          frame.localPath = null;
        }
      } else {
        frame.localPath = null;
      }
      allFrames.push(frame);
    }
  }

  // Clean up temp dirs now that screenshots have been copied
  for (const tmpDir of tmpDirs) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  // Determine relative paths for manifest (relative to RECORDINGS_DIR)
  const relOutDir = path.relative(RECORDINGS_DIR, outDir);
  const relContactSheet = path.relative(RECORDINGS_DIR, path.join(outDir, 'contact-sheet.html'));
  const relVideo = videoFile
    ? path.relative(RECORDINGS_DIR, path.join(testResultDir, videoFile))
    : null;

  const firstFrame = allFrames.find((f) => f.localPath);
  const lastFrame = [...allFrames].reverse().find((f) => f.localPath);

  const relFirstFrame = firstFrame?.localPath
    ? path.join(relOutDir, 'frames', firstFrame.localPath)
    : null;
  const relLastFrame = lastFrame?.localPath
    ? path.join(relOutDir, 'frames', lastFrame.localPath)
    : null;

  // Generate contact sheet HTML
  const videoRelPath = videoFile
    ? path.relative(outDir, path.join(testResultDir, videoFile))
    : null;

  const html = buildContactSheetHtml({
    testName: testDirName,
    packageName,
    timestamp: new Date().toISOString(),
    frames: allFrames,
    videoRelPath,
    framesDir,
  });

  fs.writeFileSync(path.join(outDir, 'contact-sheet.html'), html, 'utf8');

  return {
    name: testDirName,
    slug,
    package: packageName,
    resultDir: path.relative(RECORDINGS_DIR, testResultDir),
    contactSheet: relContactSheet,
    video: relVideo,
    frameCount: allFrames.filter((f) => f.localPath).length,
    firstFrame: relFirstFrame,
    lastFrame: relLastFrame,
  };
}

/** Build the HTML string for one contact sheet. */
function buildContactSheetHtml({ testName, packageName, timestamp, frames, videoRelPath, framesDir }) {
  const framesWithScreenshots = frames.filter((f) => f.localPath);

  const firstFrameIdx = frames.findIndex((f) => f.localPath);
  const lastFrameIdx = frames.reduce((acc, f, idx) => (f.localPath ? idx : acc), -1);

  const frameCards = frames
    .map((frame, i) => {
      const isFirst = i === firstFrameIdx;
      const isLast = i === lastFrameIdx && lastFrameIdx !== firstFrameIdx;
      const labelText = frame.apiName || '(unknown)';
      const paramsText = summariseParams(frame.apiName, frame.params);
      const bgColor = actionColor(frame.apiName);

      const prominence = isFirst ? 'first-frame' : isLast ? 'last-frame' : '';
      const prominenceLabel = isFirst ? 'FIRST FRAME' : isLast ? 'LAST FRAME' : '';

      const imgHtml = frame.localPath
        ? `<img src="frames/${frame.localPath}" alt="${escHtml(labelText)}" loading="lazy">`
        : `<div class="no-screenshot">no screenshot</div>`;

      return `
    <div class="frame-card ${prominence}">
      ${prominenceLabel ? `<div class="prominence-label">${prominenceLabel}</div>` : ''}
      <div class="action-label" style="background:${bgColor}">
        <span class="api-name">${escHtml(labelText)}</span>
        ${paramsText ? `<span class="params">${escHtml(paramsText)}</span>` : ''}
      </div>
      ${imgHtml}
      <div class="frame-index">#${String(i + 1).padStart(3, '0')}</div>
    </div>`;
    })
    .join('\n');

  const videoSection = videoRelPath
    ? `<section class="video-section">
      <h2>Recording</h2>
      <video controls src="${escHtml(videoRelPath)}" style="max-width:100%;border-radius:6px;"></video>
    </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Contact Sheet — ${escHtml(testName)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0d0d0d;
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 24px;
  }
  header {
    margin-bottom: 24px;
    border-bottom: 1px solid #2a2a2a;
    padding-bottom: 16px;
  }
  header h1 { font-size: 1.3rem; font-weight: 600; color: #fff; }
  header .meta { font-size: 0.8rem; color: #888; margin-top: 6px; }
  header .package-badge {
    display: inline-block;
    background: #ff6600;
    color: #fff;
    font-size: 0.7rem;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 4px;
    margin-right: 8px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .video-section { margin-bottom: 32px; }
  .video-section h2 { font-size: 1rem; margin-bottom: 10px; color: #ccc; }
  .frames-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
  }
  .frame-card {
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    overflow: hidden;
    position: relative;
  }
  .frame-card.first-frame { border-color: #2ecc71; border-width: 2px; }
  .frame-card.last-frame  { border-color: #e74c3c; border-width: 2px; }
  .prominence-label {
    position: absolute;
    top: 0; left: 0; right: 0;
    text-align: center;
    font-size: 0.65rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    padding: 3px 0;
    z-index: 2;
  }
  .first-frame .prominence-label { background: #2ecc71; color: #000; }
  .last-frame  .prominence-label { background: #e74c3c; color: #fff; }
  .action-label {
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .first-frame .action-label,
  .last-frame  .action-label { padding-top: 20px; }
  .api-name { font-size: 0.78rem; font-weight: 600; color: #fff; }
  .params   { font-size: 0.7rem; color: #ccc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .frame-card img {
    width: 100%;
    display: block;
    background: #111;
  }
  .no-screenshot {
    height: 80px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    color: #555;
    background: #111;
  }
  .frame-index {
    font-size: 0.65rem;
    color: #444;
    text-align: right;
    padding: 4px 8px;
  }
  .summary { margin-bottom: 20px; font-size: 0.85rem; color: #888; }
</style>
</head>
<body>
<header>
  <h1>
    <span class="package-badge">${escHtml(packageName)}</span>
    ${escHtml(testName)}
  </h1>
  <div class="meta">
    Generated: ${escHtml(timestamp)} &nbsp;·&nbsp;
    ${framesWithScreenshots.length} screenshot${framesWithScreenshots.length !== 1 ? 's' : ''} &nbsp;·&nbsp;
    ${frames.length} action${frames.length !== 1 ? 's' : ''}
  </div>
</header>

${videoSection}

<div class="summary">${frames.length} actions recorded</div>

<div class="frames-grid">
${frameCards}
</div>
</body>
</html>`;
}

/** Minimal HTML entity escaping. */
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Find all package recording directories under e2e-recordings/. */
function findPackageDirs() {
  if (!fs.existsSync(RECORDINGS_DIR)) return [];
  return fs
    .readdirSync(RECORDINGS_DIR)
    .filter((name) => {
      if (name === 'contact-sheets' || name === 'manifest.json') return false;
      const full = path.join(RECORDINGS_DIR, name);
      return fs.statSync(full).isDirectory();
    })
    .map((name) => ({ name, full: path.join(RECORDINGS_DIR, name) }));
}

/** Find all test result directories under a package recording dir. */
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

  const manifest = {
    generated: new Date().toISOString(),
    packages: {},
  };

  for (const { name: packageName, full: packageDir } of packageDirs) {
    console.log(`\nPackage: ${packageName}`);
    const testDirs = findTestResultDirs(packageDir);
    if (testDirs.length === 0) {
      console.log(`  No test-results/ directory found.`);
      continue;
    }

    const tests = [];
    for (const testDir of testDirs) {
      console.log(`  Processing: ${path.basename(testDir)}`);
      try {
        const meta = processTestDir(testDir, packageName);
        if (meta) {
          tests.push(meta);
          console.log(`    → ${meta.frameCount} frames, contact sheet generated`);
        } else {
          console.log(`    → skipped (no trace or video)`);
        }
      } catch (err) {
        console.warn(`  [error] ${testDir}: ${err.message}`);
      }
    }

    if (tests.length > 0) {
      manifest.packages[packageName] = { tests };
    }
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\nManifest written: ${MANIFEST_PATH}`);

  const totalTests = Object.values(manifest.packages).reduce(
    (sum, pkg) => sum + pkg.tests.length,
    0
  );
  console.log(`Done. ${totalTests} test(s) processed across ${Object.keys(manifest.packages).length} package(s).`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
