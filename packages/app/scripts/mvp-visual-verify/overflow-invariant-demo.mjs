#!/usr/bin/env node
/**
 * Live demonstration that the horizontal-overflow invariant catches the WS5
 * transcript bug in a REAL browser — not a mock.
 *
 * It renders two fixtures in headless chromium at a phone viewport: a BUGGY chat
 * transcript whose long unbreakable token is NOT contained (no overflow-x:hidden
 * on the transcript, no wrap on the bubble), so the child pushes the document
 * wider than the viewport — the user-visible horizontal-scrollbar symptom — and
 * the FIXED version (`overflow-x:hidden` + `overflow-wrap:anywhere`). It measures
 * each with the exact probe the audit spec records into report.json and asserts
 * the invariant fires on the bug and passes on the fix. Exit 0 only when the
 * invariant correctly distinguishes them, so this doubles as a self-test of the
 * capture-side gate.
 *
 * Note the CSS subtlety this fixture is built around: setting `overflow-y:auto`
 * alone auto-promotes `overflow-x` to `auto` (CSS Overflow 3 §3), which would
 * self-contain the token inside the scroller and hide the bug. The real
 * document-level leak — what a user actually sees — comes from an un-contained
 * wide descendant, which is what BUGGY reproduces.
 *
 * Run: node scripts/mvp-visual-verify/overflow-invariant-demo.mjs
 */

import { chromium } from "playwright";

const TOLERANCE_PX = 2;
const VIEWPORT = { width: 390, height: 844 };
const LONG_TOKEN = `https://example.com/a/really/long/unbreakable/path/token/${"x".repeat(400)}`;

const SHELL = (
  transcriptCss,
  bubbleCss,
) => `<!doctype html><html><head><meta charset="utf-8">
<style>
  * { margin: 0; box-sizing: border-box; }
  body { font: 14px system-ui; }
  .app { width: 100vw; height: 100vh; display: flex; flex-direction: column; }
  .transcript { flex: 1; padding: 12px; ${transcriptCss} }
  .bubble { background: #f0ece5; border-radius: 12px; padding: 10px 14px; margin: 8px 0; ${bubbleCss} }
</style></head><body>
  <div class="app"><div class="transcript">
    <div class="bubble">short message</div>
    <div class="bubble long">${LONG_TOKEN}</div>
    <div class="bubble">another short one</div>
  </div></div>
</body></html>`;

// BUGGY: the long token is un-contained — the transcript has no horizontal
// containment and the bubble does not wrap, so the token pushes the whole
// document wider than the viewport. FIXED: the vertical scroller adds
// overflow-x:hidden (the WS5 remedy) and the bubble wraps long tokens.
const BUGGY = SHELL("", "white-space: nowrap;");
const FIXED = SHELL(
  "overflow-y: auto; overflow-x: hidden;",
  "overflow-wrap: anywhere;",
);

/** The exact probe recorded into report.json by all-views-aesthetic-audit.spec.ts. */
function overflowProbe() {
  const de = document.documentElement;
  const scrollWidth = Math.max(de.scrollWidth, document.body?.scrollWidth ?? 0);
  const innerWidth = window.innerWidth || de.clientWidth;
  return Math.max(0, Math.round(scrollWidth - innerWidth));
}

async function measure(page, html) {
  await page.setContent(html, { waitUntil: "load" });
  return page.evaluate(overflowProbe);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT });
  const buggyPx = await measure(page, BUGGY);
  const fixedPx = await measure(page, FIXED);
  await browser.close();

  const caught = buggyPx > TOLERANCE_PX;
  const fixedOk = fixedPx <= TOLERANCE_PX;
  process.stdout.write(
    `[overflow-demo] viewport ${VIEWPORT.width}x${VIEWPORT.height}, tolerance ${TOLERANCE_PX}px\n` +
      `[overflow-demo] BUGGY (un-contained token):     ${buggyPx}px  -> ${caught ? "INVARIANT FIRES ✓" : "missed ✗"}\n` +
      `[overflow-demo] FIXED (overflow-x:hidden+wrap): ${fixedPx}px  -> ${fixedOk ? "passes ✓" : "false-fires ✗"}\n`,
  );
  if (caught && fixedOk) {
    process.stdout.write(
      "[overflow-demo] PASS — the invariant catches the regression and clears the fix\n",
    );
    return 0;
  }
  process.stdout.write(
    "[overflow-demo] FAIL — invariant did not distinguish bug from fix\n",
  );
  return 1;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    process.stderr.write(`[overflow-demo] error: ${e?.stack || e}\n`);
    process.exit(2);
  },
);
