#!/usr/bin/env node

/**
 * Real-browser proof that the reconnecting indicator does not shift page content.
 *
 * Reproduces the shell's content column (App.tsx:2479 — a `position: relative`
 * flex-column with the banner as the first child, then the header + page) and
 * measures the header's viewport Y across three banner treatments:
 *   1. no banner            (baseline)
 *   2. in-flow bar shown    (`shrink-0` flex item that pushes content down)
 *   3. overlay pill shown   (absolutely-positioned, out of flow)
 *
 * A 0px shift in state 3 vs. baseline proves the overlay pill is layout-neutral;
 * the non-zero shift in state 2 shows the in-flow variant it avoids. Screenshots
 * are written for review.
 *
 * Usage: node packages/ui/scripts/reconnecting-shift-proof.mjs [--out <dir>]
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..", "..");
const args = process.argv.slice(2);
let outDir = resolve(repoRoot, "test-results/evidence");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") outDir = resolve(args[++i]);
}
mkdirSync(outDir, { recursive: true });

// Structural replica of the shell content column. Both banner variants use the
// same box (44px tall, full width) so the ONLY difference under test is
// in-flow vs. overlay positioning — exactly the change in ConnectionFailedBanner.
const page = (variant) => {
  const banner =
    variant === "old"
      ? `<div class="banner-inflow">Reconnecting… (3/15)</div>`
      : variant === "new"
        ? `<div class="overlay"><div class="pill">Reconnecting… (3/15)</div></div>`
        : "";
  return `<!doctype html><html><head><style>
    * { margin: 0; box-sizing: border-box; font-family: system-ui, sans-serif; }
    body { background: #0b0b0d; color: #e8e8ea; }
    /* App.tsx:2479 column */
    .column { position: relative; display: flex; min-height: 100vh; width: 100%; flex-direction: column; }
    /* OLD: in-flow flex item (shrink-0) — consumes 44px, pushes content down */
    .banner-inflow { flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
      height: 44px; padding: 0 16px; background: #b7791f; color: #1a1205; font-weight: 600; }
    /* NEW: absolute overlay — consumes NO layout height */
    .overlay { position: absolute; left: 0; right: 0; top: 8px; z-index: 9999;
      display: flex; justify-content: center; pointer-events: none; }
    /* bg = --warn (#ff8a24); text = --brand-black (#000) for accessible ~8:1 contrast */
    .pill { display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 16px;
      border-radius: 9999px; background: #ff8a24; color: #000; font-weight: 600;
      box-shadow: 0 4px 12px rgba(0,0,0,.35); }
    .header { flex: 0 0 auto; height: 56px; display: flex; align-items: center; gap: 16px;
      padding: 0 16px; border-bottom: 1px solid #26262b; }
    .tab { font-weight: 600; } .tab.muted { color: #8a8a90; }
    #content { flex: 1 1 auto; padding: 16px; }
  </style></head><body>
    <div class="column">
      ${banner}
      <div class="header" id="header"><span class="tab">Chat</span><span class="tab muted">Apps</span><span class="tab muted">Settings</span></div>
      <div id="content"><h2>Conversation</h2><p>The page content should not move when the reconnecting indicator appears.</p></div>
    </div>
  </body></html>`;
};

const headerY = async (p) =>
  p.$eval("#header", (el) => Math.round(el.getBoundingClientRect().top));

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 900, height: 600 },
    deviceScaleFactor: 2,
  });
  const p = await ctx.newPage();

  await p.setContent(page("none"));
  const baseY = await headerY(p);
  await p.screenshot({
    path: resolve(outDir, "reconnecting-shift-baseline.png"),
  });

  await p.setContent(page("old"));
  const oldY = await headerY(p);
  await p.screenshot({
    path: resolve(outDir, "reconnecting-shift-old-inflow.png"),
  });

  await p.setContent(page("new"));
  const newY = await headerY(p);
  await p.screenshot({
    path: resolve(outDir, "reconnecting-shift-new-overlay.png"),
  });

  const oldShift = Math.abs(oldY - baseY);
  const newShift = Math.abs(newY - baseY);

  console.log(`baseline header Y:        ${baseY}px`);
  console.log(
    `OLD in-flow bar header Y: ${oldY}px  → shift ${oldShift}px  (the bug)`,
  );
  console.log(
    `NEW overlay pill header Y:${newY}px  → shift ${newShift}px  (the fix)`,
  );
  console.log(`\nscreenshots → ${outDir}`);

  if (newShift !== 0) {
    console.error(`\n❌ FAIL: overlay still shifted content by ${newShift}px`);
    process.exit(1);
  }
  if (oldShift === 0) {
    console.error(
      `\n❌ FAIL: in-flow control did not shift — replica is wrong`,
    );
    process.exit(1);
  }
  console.log(
    `\n✅ Overlay pill causes 0px shift; in-flow bar shifted ${oldShift}px.`,
  );
} finally {
  await browser.close();
}
