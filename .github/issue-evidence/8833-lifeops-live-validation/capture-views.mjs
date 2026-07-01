// Credential-free LifeOps view walkthrough against the LIVE dev app (:2138).
// Dismisses onboarding via "This device" (local, no cloud login), then
// navigates every LifeOps domain view, screenshotting each, with a full video
// recording of the walk. Evidence for #8833 item 4 (view rendering + UX).
//
// Run: bun .github/issue-evidence/8833-lifeops-live-validation/capture-views.mjs

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const OUT = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(OUT, "views");
mkdirSync(SHOTS, { recursive: true });

const BASE = process.env.ELIZA_UI_BASE ?? "http://localhost:2138";
const VIEWS = [
  "/calendar",
  "/inbox",
  "/health",
  "/finances",
  "/focus",
  "/goals",
  "/documents",
  "/relationships",
  "/todos",
  "/phone",
];

const log = (m) => process.stdout.write(`[capture] ${m}\n`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 832 },
  recordVideo: { dir: join(OUT, "video"), size: { width: 1280, height: 832 } },
});
// Seed the onboarding-complete localStorage flags BEFORE any app JS runs, so
// the first-run gate is bypassed and views render against the local embedded
// runtime (mirrors packages/app/test/ui-smoke/helpers.ts DEFAULT_APP_STORAGE).
const context2 = context;
await context2.addInitScript(() => {
  const entries = {
    "eliza:first-run-complete": "1",
    "eliza:setup:step": "activate",
    "eliza:ui-shell-mode": "native",
    "eliza:tutorial-autolaunched": "1",
    "elizaos:active-server": JSON.stringify({
      id: "local:embedded",
      kind: "local",
      label: "This device",
    }),
  };
  for (const [k, v] of Object.entries(entries)) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  }
});

const page = await context.newPage();
const results = [];

try {
  log(`goto ${BASE}/ (onboarding seeded)`);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: join(SHOTS, "00-home.png") });

  for (const view of VIEWS) {
    const slug = view.replace(/\//g, "") || "root";
    try {
      log(`view ${view}`);
      await page.goto(`${BASE}${view}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      const shot = join(SHOTS, `${slug}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      const title = await page.title().catch(() => "");
      const bodyLen = await page
        .evaluate(() => document.body?.innerText?.length ?? 0)
        .catch(() => 0);
      results.push({ view, slug, title, bodyTextLen: bodyLen, ok: true });
    } catch (err) {
      log(`view ${view} FAILED: ${err}`);
      results.push({ view, slug, ok: false, error: String(err) });
    }
  }
} finally {
  await page.waitForTimeout(500);
  await context.close(); // flushes the video
  await browser.close();
}

log(`results: ${JSON.stringify(results, null, 2)}`);
const ok = results.filter((r) => r.ok && (r.bodyTextLen ?? 0) > 40).length;
log(`rendered ${ok}/${VIEWS.length} views with content`);
process.exit(0);
