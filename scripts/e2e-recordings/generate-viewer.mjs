#!/usr/bin/env node
/**
 * generate-viewer.mjs
 *
 * Reads e2e-recordings/manifest.json and generates e2e-recordings/index.html —
 * a self-contained dark-themed viewer with package filter tabs, search,
 * and test cards linking to contact sheets and videos.
 *
 * Usage:
 *   node scripts/e2e-recordings/generate-viewer.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RECORDINGS_DIR = path.join(REPO_ROOT, 'e2e-recordings');
const MANIFEST_PATH = path.join(RECORDINGS_DIR, 'manifest.json');
const OUTPUT_PATH = path.join(RECORDINGS_DIR, 'index.html');

/** Minimal HTML entity escaping. */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build a JSON-safe string for inline embedding. */
function jsonStr(obj) {
  return JSON.stringify(obj).replace(/<\//g, '<\\/');
}

function buildHtml(manifest) {
  const packages = manifest.packages ?? {};
  const packageNames = Object.keys(packages).sort();

  // Flatten all tests into a single array with package info attached
  const allTests = [];
  for (const pkgName of packageNames) {
    const tests = packages[pkgName]?.tests ?? [];
    for (const test of tests) {
      allTests.push({ ...test, package: test.package ?? pkgName });
    }
  }

  // Inline all test data as JSON for the client-side JS
  const testsJson = jsonStr(allTests);
  const packageNamesJson = jsonStr(packageNames);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>E2E Recordings — Index</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0d0d0d;
    --surface: #161616;
    --surface2: #1e1e1e;
    --border: #2a2a2a;
    --text: #e0e0e0;
    --text-muted: #888;
    --accent: #ff6600;
    --accent-dark: #cc5200;
    --pass: #2ecc71;
    --fail: #e74c3c;
    --radius: 8px;
  }

  html, body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh;
  }

  /* ─── Layout ─────────────────────────────────────────────── */
  .page-header {
    padding: 28px 32px 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 0;
  }
  .page-header h1 {
    font-size: 1.4rem;
    font-weight: 700;
    color: #fff;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .page-header h1 .logo {
    display: inline-block;
    width: 18px;
    height: 18px;
    background: var(--accent);
    border-radius: 3px;
  }
  .page-header .meta {
    font-size: 0.78rem;
    color: var(--text-muted);
    margin-top: 6px;
    margin-bottom: 16px;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    padding: 16px 32px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    position: sticky;
    top: 0;
    z-index: 10;
  }

  /* ─── Filter Tabs ─────────────────────────────────────────── */
  .filter-tabs {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .tab-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    padding: 5px 14px;
    border-radius: 20px;
    font-size: 0.78rem;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }
  .tab-btn:hover { border-color: var(--accent); color: var(--text); }
  .tab-btn.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }

  /* ─── Search ──────────────────────────────────────────────── */
  .search-wrap { flex: 1; min-width: 160px; max-width: 360px; }
  .search-input {
    width: 100%;
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 7px 12px;
    border-radius: 6px;
    font-size: 0.82rem;
    outline: none;
  }
  .search-input:focus { border-color: var(--accent); }
  .search-input::placeholder { color: var(--text-muted); }

  /* ─── Count ───────────────────────────────────────────────── */
  .result-count {
    font-size: 0.78rem;
    color: var(--text-muted);
    margin-left: auto;
    white-space: nowrap;
  }

  /* ─── Main Grid ───────────────────────────────────────────── */
  .grid-wrapper { padding: 24px 32px; }
  .tests-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 16px;
  }

  .empty-state {
    grid-column: 1 / -1;
    text-align: center;
    padding: 80px 0;
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  /* ─── Test Card ───────────────────────────────────────────── */
  .test-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: border-color 0.15s, transform 0.1s;
  }
  .test-card:hover {
    border-color: #3a3a3a;
    transform: translateY(-1px);
  }

  .card-thumb {
    width: 100%;
    aspect-ratio: 16/9;
    object-fit: cover;
    background: #111;
    display: block;
  }
  .card-thumb-placeholder {
    width: 100%;
    aspect-ratio: 16/9;
    background: #111;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    color: #333;
  }

  .card-body { padding: 12px; flex: 1; }
  .card-top {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 8px;
  }

  .pkg-badge {
    flex-shrink: 0;
    display: inline-block;
    background: var(--accent);
    color: #fff;
    font-size: 0.65rem;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 2px;
  }

  .card-name {
    font-size: 0.82rem;
    font-weight: 500;
    color: #ddd;
    line-height: 1.4;
    word-break: break-word;
  }

  .card-meta {
    font-size: 0.72rem;
    color: var(--text-muted);
    margin-bottom: 10px;
  }

  .card-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .card-link {
    font-size: 0.72rem;
    padding: 4px 10px;
    border-radius: 4px;
    text-decoration: none;
    font-weight: 500;
    border: 1px solid transparent;
    transition: background 0.12s;
  }
  .card-link.primary {
    background: var(--accent);
    color: #fff;
  }
  .card-link.primary:hover { background: var(--accent-dark); }
  .card-link.secondary {
    background: var(--surface2);
    border-color: var(--border);
    color: var(--text);
  }
  .card-link.secondary:hover { border-color: var(--accent); color: var(--accent); }
  .card-link.na {
    background: none;
    border-color: #333;
    color: #444;
    cursor: default;
  }

  .status-badge {
    display: inline-block;
    font-size: 0.65rem;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 4px;
    letter-spacing: 0.03em;
  }
  .status-pass { background: #1a3d2a; color: var(--pass); }
  .status-fail { background: #3d1a1a; color: var(--fail); }

  @media (max-width: 640px) {
    .page-header, .toolbar, .grid-wrapper { padding-left: 16px; padding-right: 16px; }
    .tests-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<div class="page-header">
  <h1><span class="logo"></span> E2E Recordings</h1>
  <div class="meta">Generated: ${esc(manifest.generated ?? '')} &nbsp;·&nbsp; ${allTests.length} test${allTests.length !== 1 ? 's' : ''} across ${packageNames.length} package${packageNames.length !== 1 ? 's' : ''}</div>
</div>

<div class="toolbar">
  <div class="filter-tabs" id="filterTabs">
    <button class="tab-btn active" data-pkg="__all__">All</button>
    ${packageNames.map((p) => `<button class="tab-btn" data-pkg="${esc(p)}">${esc(p)}</button>`).join('\n    ')}
  </div>
  <div class="search-wrap">
    <input class="search-input" id="searchInput" type="search" placeholder="Search tests…">
  </div>
  <div class="result-count" id="resultCount"></div>
</div>

<div class="grid-wrapper">
  <div class="tests-grid" id="testsGrid"></div>
</div>

<script>
(function () {
  const ALL_TESTS = ${testsJson};
  const PACKAGE_NAMES = ${packageNamesJson};

  let activePackage = '__all__';
  let searchQuery = '';

  function getFilteredTests() {
    return ALL_TESTS.filter((t) => {
      if (activePackage !== '__all__' && t.package !== activePackage) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!t.name.toLowerCase().includes(q) && !t.package.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }

  function renderGrid() {
    const grid = document.getElementById('testsGrid');
    const count = document.getElementById('resultCount');
    const tests = getFilteredTests();

    count.textContent = tests.length + ' test' + (tests.length !== 1 ? 's' : '');

    if (tests.length === 0) {
      grid.innerHTML = '<div class="empty-state">No tests match the current filter.</div>';
      return;
    }

    grid.innerHTML = tests.map((t) => buildCard(t)).join('');
  }

  function buildCard(t) {
    const thumbHtml = t.firstFrame
      ? \`<img class="card-thumb" src="\${esc(t.firstFrame)}" alt="" loading="lazy">\`
      : \`<div class="card-thumb-placeholder">no screenshot</div>\`;

    const contactSheetLink = t.contactSheet
      ? \`<a class="card-link primary" href="\${esc(t.contactSheet)}">Contact Sheet</a>\`
      : \`<span class="card-link na">no contact sheet</span>\`;

    const videoLink = t.video
      ? \`<a class="card-link secondary" href="\${esc(t.video)}">Video</a>\`
      : \`<span class="card-link na">no video</span>\`;

    const statusBadge = t.status === 'pass'
      ? \`<span class="status-badge status-pass">PASS</span> \`
      : t.status === 'fail'
      ? \`<span class="status-badge status-fail">FAIL</span> \`
      : '';

    const frameMeta = t.frameCount != null
      ? \`\${t.frameCount} frame\${t.frameCount !== 1 ? 's' : ''}\`
      : '';

    return \`
<div class="test-card" data-pkg="\${esc(t.package)}" data-name="\${esc(t.name.toLowerCase())}">
  \${thumbHtml}
  <div class="card-body">
    <div class="card-top">
      <span class="pkg-badge">\${esc(t.package)}</span>
      <span class="card-name">\${esc(t.name)}</span>
    </div>
    <div class="card-meta">\${statusBadge}\${frameMeta}</div>
    <div class="card-actions">
      \${contactSheetLink}
      \${videoLink}
    </div>
  </div>
</div>\`;
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Tabs
  document.getElementById('filterTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    activePackage = btn.dataset.pkg;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderGrid();
  });

  // Search
  document.getElementById('searchInput').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    renderGrid();
  });

  // Initial render
  renderGrid();
})();
</script>
</body>
</html>`;
}

function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`manifest.json not found at ${MANIFEST_PATH}`);
    console.error('Run generate-contact-sheets.mjs first.');
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse manifest.json: ${err.message}`);
    process.exit(1);
  }

  const html = buildHtml(manifest);
  fs.writeFileSync(OUTPUT_PATH, html, 'utf8');
  console.log(`Viewer written: ${OUTPUT_PATH}`);

  const totalTests = Object.values(manifest.packages ?? {}).reduce(
    (sum, pkg) => sum + (pkg.tests?.length ?? 0),
    0
  );
  console.log(`Indexed ${totalTests} test(s) across ${Object.keys(manifest.packages ?? {}).length} package(s).`);
}

main();
