#!/usr/bin/env node
/**
 * generate-viewer.mjs
 *
 * Reads e2e-recordings/manifest.json and writes e2e-recordings/index.html —
 * ONE self-contained dark-themed page showing every test as a card with:
 *   - a horizontal filmstrip of all real frames (lazy-loaded)
 *   - a full-screen lightbox on frame click (← → Esc navigation)
 *   - a video link when a recording exists
 *   - package filter tabs + search
 *
 * No per-test contact-sheet.html files are linked or generated.
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

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function jsonStr(obj) {
  return JSON.stringify(obj).replace(/<\//g, '<\\/');
}

function buildHtml(manifest) {
  const packages = manifest.packages ?? {};
  const packageNames = Object.keys(packages).sort();

  const allTests = [];
  for (const pkgName of packageNames) {
    for (const test of packages[pkgName]?.tests ?? []) {
      allTests.push({ ...test, package: test.package ?? pkgName });
    }
  }

  const testsJson = jsonStr(allTests);
  const packageNamesJson = jsonStr(packageNames);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>E2E Recordings</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0d0d0d;
    --surface: #161616;
    --surface2: #1e1e1e;
    --border: #2a2a2a;
    --text: #e0e0e0;
    --muted: #888;
    --accent: #ff6600;
    --accent-dk: #cc5200;
    --radius: 8px;
  }

  html, body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh;
  }

  /* ── Header ── */
  .page-header {
    padding: 24px 32px 0;
    border-bottom: 1px solid var(--border);
  }
  .page-header h1 {
    font-size: 1.35rem;
    font-weight: 700;
    color: #fff;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .page-header h1 .logo {
    width: 16px; height: 16px;
    background: var(--accent);
    border-radius: 3px;
    flex-shrink: 0;
  }
  .page-header .meta {
    font-size: 0.75rem;
    color: var(--muted);
    margin: 6px 0 16px;
  }

  /* ── Toolbar ── */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 14px 32px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .filter-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
  .tab-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 4px 13px;
    border-radius: 20px;
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 0.12s;
    white-space: nowrap;
  }
  .tab-btn:hover { border-color: var(--accent); color: var(--text); }
  .tab-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .search-wrap { flex: 1; min-width: 150px; max-width: 340px; }
  .search-input {
    width: 100%;
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 11px;
    border-radius: 6px;
    font-size: 0.8rem;
    outline: none;
  }
  .search-input:focus { border-color: var(--accent); }
  .search-input::placeholder { color: var(--muted); }
  .result-count { font-size: 0.75rem; color: var(--muted); margin-left: auto; white-space: nowrap; }

  /* ── Grid ── */
  .grid-wrapper { padding: 20px 32px 40px; }
  .tests-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 14px;
  }
  .empty-state {
    grid-column: 1 / -1;
    text-align: center;
    padding: 80px 0;
    color: var(--muted);
    font-size: 0.9rem;
  }

  /* ── Card ── */
  .test-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: border-color 0.12s;
  }
  .test-card:hover { border-color: #3a3a3a; }

  /* ── Filmstrip ── */
  .filmstrip-wrap {
    width: 100%;
    overflow-x: auto;
    background: #111;
    scrollbar-width: thin;
    scrollbar-color: #333 #111;
  }
  .filmstrip-wrap::-webkit-scrollbar { height: 4px; }
  .filmstrip-wrap::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
  .filmstrip {
    display: flex;
    gap: 3px;
    padding: 6px;
    min-height: 90px;
    align-items: center;
  }
  .filmstrip-empty {
    width: 100%;
    min-height: 90px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    color: #333;
    background: #111;
  }
  .frame-thumb {
    flex-shrink: 0;
    height: 78px;
    width: auto;
    border-radius: 3px;
    cursor: pointer;
    border: 1px solid transparent;
    transition: border-color 0.1s, transform 0.1s;
    display: block;
    background: #0a0a0a;
  }
  .frame-thumb:hover { border-color: var(--accent); transform: scale(1.04); }
  .frame-thumb:first-child { border-color: #2ecc71; }
  .frame-thumb:last-child:not(:first-child) { border-color: #e74c3c; }

  /* ── Card body ── */
  .card-body { padding: 10px 12px; flex: 1; }
  .card-top { display: flex; align-items: flex-start; gap: 7px; margin-bottom: 6px; }
  .pkg-badge {
    flex-shrink: 0;
    background: var(--accent);
    color: #fff;
    font-size: 0.62rem;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-top: 1px;
  }
  .card-name { font-size: 0.8rem; font-weight: 500; color: #ddd; line-height: 1.35; word-break: break-word; }
  .card-meta { font-size: 0.7rem; color: var(--muted); margin-bottom: 8px; }
  .card-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .card-link {
    font-size: 0.7rem;
    padding: 3px 9px;
    border-radius: 4px;
    text-decoration: none;
    font-weight: 500;
    border: 1px solid var(--border);
    background: var(--surface2);
    color: var(--text);
    transition: border-color 0.1s, color 0.1s;
  }
  .card-link:hover { border-color: var(--accent); color: var(--accent); }
  .card-link.na { color: #444; border-color: #222; pointer-events: none; }

  /* ── Lightbox ── */
  #lb {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.92);
    z-index: 1000;
    align-items: center;
    justify-content: center;
    flex-direction: column;
  }
  #lb.open { display: flex; }
  #lb-img {
    max-width: 92vw;
    max-height: 82vh;
    border-radius: 6px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.8);
    display: block;
  }
  #lb-caption {
    margin-top: 10px;
    font-size: 0.75rem;
    color: #888;
  }
  #lb-close {
    position: fixed;
    top: 18px; right: 22px;
    background: none;
    border: none;
    color: #888;
    font-size: 1.6rem;
    cursor: pointer;
    line-height: 1;
    padding: 4px;
  }
  #lb-close:hover { color: #fff; }
  .lb-arrow {
    position: fixed;
    top: 50%;
    transform: translateY(-50%);
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    color: #ccc;
    font-size: 1.4rem;
    padding: 12px 16px;
    cursor: pointer;
    border-radius: 6px;
    user-select: none;
    transition: background 0.1s;
  }
  .lb-arrow:hover { background: rgba(255,255,255,0.12); color: #fff; }
  #lb-prev { left: 16px; }
  #lb-next { right: 16px; }

  @media (max-width: 640px) {
    .page-header, .toolbar, .grid-wrapper { padding-left: 14px; padding-right: 14px; }
    .tests-grid { grid-template-columns: 1fr; }
    #lb-prev { left: 6px; }
    #lb-next { right: 6px; }
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

<!-- Lightbox -->
<div id="lb" role="dialog" aria-modal="true">
  <button id="lb-close" aria-label="Close">&times;</button>
  <button class="lb-arrow" id="lb-prev" aria-label="Previous">&#8592;</button>
  <img id="lb-img" src="" alt="">
  <div id="lb-caption"></div>
  <button class="lb-arrow" id="lb-next" aria-label="Next">&#8594;</button>
</div>

<script>
(function () {
  const ALL_TESTS = ${testsJson};

  // ── Lightbox state ─────────────────────────────────────────
  let lbFrames = [];
  let lbIdx = 0;

  const lb = document.getElementById('lb');
  const lbImg = document.getElementById('lb-img');
  const lbCap = document.getElementById('lb-caption');

  function openLightbox(frames, idx) {
    lbFrames = frames;
    lbIdx = idx;
    showLbFrame();
    lb.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeLightbox() {
    lb.classList.remove('open');
    document.body.style.overflow = '';
  }
  function showLbFrame() {
    lbImg.src = lbFrames[lbIdx] ?? '';
    lbCap.textContent = 'Frame ' + (lbIdx + 1) + ' / ' + lbFrames.length;
  }

  document.getElementById('lb-close').addEventListener('click', closeLightbox);
  document.getElementById('lb-prev').addEventListener('click', () => {
    if (lbFrames.length === 0) return;
    lbIdx = (lbIdx - 1 + lbFrames.length) % lbFrames.length;
    showLbFrame();
  });
  document.getElementById('lb-next').addEventListener('click', () => {
    if (lbFrames.length === 0) return;
    lbIdx = (lbIdx + 1) % lbFrames.length;
    showLbFrame();
  });
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
  document.addEventListener('keydown', (e) => {
    if (!lb.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') { lbIdx = (lbIdx - 1 + lbFrames.length) % lbFrames.length; showLbFrame(); }
    if (e.key === 'ArrowRight') { lbIdx = (lbIdx + 1) % lbFrames.length; showLbFrame(); }
  });

  // ── Filtering ───────────────────────────────────────────────
  let activePackage = '__all__';
  let searchQuery = '';

  function getFiltered() {
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
    const countEl = document.getElementById('resultCount');
    const tests = getFiltered();
    countEl.textContent = tests.length + ' test' + (tests.length !== 1 ? 's' : '');
    if (tests.length === 0) {
      grid.innerHTML = '<div class="empty-state">No tests match the current filter.</div>';
      return;
    }
    grid.innerHTML = tests.map(buildCard).join('');
    // Wire up filmstrip click handlers
    grid.querySelectorAll('.frame-thumb').forEach((img) => {
      img.addEventListener('click', () => {
        const frames = JSON.parse(img.closest('.test-card').dataset.frames);
        const idx = parseInt(img.dataset.idx, 10);
        openLightbox(frames, idx);
      });
    });
  }

  function buildCard(t) {
    const frames = t.frames ?? [];
    let filmstrip;
    if (frames.length === 0) {
      filmstrip = '<div class="filmstrip-empty">no frames</div>';
    } else {
      const thumbs = frames.map((src, i) =>
        '<img class="frame-thumb" src="' + esc(src) + '" loading="lazy" data-idx="' + i + '" alt="frame ' + (i+1) + '">'
      ).join('');
      filmstrip = '<div class="filmstrip-wrap"><div class="filmstrip">' + thumbs + '</div></div>';
    }

    const videoLink = t.video
      ? '<a class="card-link" href="' + esc(t.video) + '" target="_blank">Video</a>'
      : '<span class="card-link na">no video</span>';

    const framesMeta = t.frameCount != null
      ? t.frameCount + ' frame' + (t.frameCount !== 1 ? 's' : '')
      : '';

    return (
      '<div class="test-card" data-pkg="' + esc(t.package) + '" data-frames=\'' + escAttr(JSON.stringify(frames)) + '\'>' +
      filmstrip +
      '<div class="card-body">' +
        '<div class="card-top">' +
          '<span class="pkg-badge">' + esc(t.package) + '</span>' +
          '<span class="card-name">' + esc(t.name) + '</span>' +
        '</div>' +
        '<div class="card-meta">' + esc(framesMeta) + '</div>' +
        '<div class="card-actions">' + videoLink + '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function escAttr(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  document.getElementById('filterTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    activePackage = btn.dataset.pkg;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderGrid();
  });

  document.getElementById('searchInput').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    renderGrid();
  });

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
    0,
  );
  console.log(`Indexed ${totalTests} test(s) across ${Object.keys(manifest.packages ?? {}).length} package(s).`);
}

main();
