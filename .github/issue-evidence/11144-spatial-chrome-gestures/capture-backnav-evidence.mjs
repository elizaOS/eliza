// Evidence capture for #11144/#11343: before/after of the shell-backnav
// clearance on the decomposed spatial views, desktop + Pixel-7. "Before"
// recreates the bug state pixel-exactly by zeroing SpatialSurface's
// padding-top consumption of --shell-backnav-clearance (the exact seam the
// fix adds in packages/ui/src/spatial/dom.tsx); "after" is the shipped fix.
// Run with the ui-smoke live stack up:
//   ELIZA_UI_SMOKE_PORT=36202 node capture-backnav-evidence.mjs
import { chromium, devices } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const base = `http://127.0.0.1:${process.env.ELIZA_UI_SMOKE_PORT || "36202"}`;
const outDir = join(here, "screenshots");

// Mirrors DEFAULT_APP_STORAGE in packages/app/test/ui-smoke/helpers.ts.
const seededStorage = {
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

const browser = await chromium.launch();
for (const [label, ctxOpts] of [
  ["desktop", { viewport: { width: 1280, height: 800 } }],
  ["pixel7", { ...devices["Pixel 7"] }],
]) {
  for (const [state, css] of [
    ["before-occluded", "[data-spatial-surface]{padding-top:0px!important}"],
    ["after-clearance", ""],
  ]) {
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    await page.addInitScript((entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
      sessionStorage.setItem("eliza:ui-smoke-storage-seeded", "1");
    }, seededStorage);
    for (const path of ["/inbox", "/relationships"]) {
      await page.goto(base + path, { waitUntil: "domcontentloaded" });
      await page
        .waitForSelector('[data-spatial-kind="button"]', { timeout: 90_000 })
        .catch(() => null);
      if (css) await page.addStyleTag({ content: css });
      await page.waitForTimeout(800);
      const slug = path.replace(/\//g, "");
      await page.screenshot({
        path: join(outDir, `${slug}-${label}-${state}.png`),
        fullPage: false,
      });
      console.log(`captured ${slug}-${label}-${state}.png`);
    }
    await ctx.close();
  }
}
await browser.close();
