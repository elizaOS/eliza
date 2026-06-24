/**
 * Real-browser e2e + screenshot + video for the Springboard view launcher —
 * no app server. Bundles springboard-fixture.tsx with esbuild, loads it in
 * headless chromium via Playwright, and:
 *
 *   - asserts the springboard + tiles render (≥1 tile, ≥1 image tile),
 *   - captures REST + EDIT screenshots at desktop (1180×900) and mobile
 *     (402×874),
 *   - records a .webm walkthrough driving REAL interactions: tap-launch a tile,
 *     long-press-to-edit (pointerdown + wait), toggle a favorite, page-nav,
 *   - reads window.__ELIZA_VIEW_INTERACTION_TELEMETRY__ and asserts a `launch`
 *     and a `favorite` action fired — proving the client telemetry stream emits
 *     on real interactions (closing the telemetry-reader loop).
 *
 * Exits non-zero on any failed assertion or page error.
 *
 * Run: bun run --cwd packages/ui test:springboard-e2e
 */

import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-springboard");
const videoDir = join(outDir, "video");
await mkdir(outDir, { recursive: true });
await mkdir(videoDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

const result = await build({
  entryPoints: [join(here, "springboard-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
});
const js = result.outputFiles[0].text;
console.log(`✓ fixture bundled (${js.length} bytes)`);
const html = `<!doctype html><html><head><meta charset="utf-8"><title>springboard e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%;background:#0a0d16;color:#f4f4f5}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "springboard.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

let shot = 0;
async function snap(p, name) {
  const file = `${name}.png`;
  // Freeze CSS animations (the edit-mode animate-pulse + Reorder transitions)
  // and retry: headless chromium intermittently throws "Unable to capture
  // screenshot" if the compositor is mid-frame. animations:"disabled" + a short
  // retry makes the capture deterministic instead of flaky.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await p.screenshot({ path: join(outDir, file), animations: "disabled" });
      shot += 1;
      console.log(`  📸 ${file}`);
      return;
    } catch (err) {
      lastErr = err;
      await p.waitForTimeout(300);
    }
  }
  assert(false, `screenshot ${file} failed after retries: ${lastErr}`);
}

/** Dispatch a real touch-pointer press at an element's centre, held `ms`. */
async function longPress(p, testid, ms) {
  const box = await p.getByTestId(testid).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await p.evaluate(
    ({ cx, cy }) => {
      const el = document.elementFromPoint(cx, cy);
      window.__lp = el;
      el?.dispatchEvent(
        new PointerEvent("pointerdown", {
          pointerId: 1,
          pointerType: "touch",
          clientX: cx,
          clientY: cy,
          bubbles: true,
        }),
      );
    },
    { cx, cy },
  );
  await p.waitForTimeout(ms);
  await p.evaluate(
    ({ cx, cy }) =>
      window.__lp?.dispatchEvent(
        new PointerEvent("pointerup", {
          pointerId: 1,
          pointerType: "touch",
          clientX: cx,
          clientY: cy,
          bubbles: true,
        }),
      ),
    { cx, cy },
  );
}

const readTelemetry = (p) =>
  p.evaluate(() => window.__ELIZA_VIEW_INTERACTION_TELEMETRY__ ?? []);
const readCalls = (p) => p.evaluate(() => window.__springboardCalls ?? {});

const errors = [];
const browser = await chromium.launch();

// ── Screenshots: desktop + mobile, REST + EDIT ─────────────────────────────
async function captureViewport(name, viewport, deviceScaleFactor) {
  const page = await browser.newPage({ viewport, deviceScaleFactor });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForSelector('[data-testid="springboard"]');
  await page.waitForTimeout(400);

  const tiles = await page.locator('[data-testid^="springboard-tile-"]').count();
  assert(tiles >= 1, `${name}: ≥1 tile renders (${tiles})`);
  const images = await page
    .locator('[data-testid^="springboard-image-"]')
    .count();
  assert(images >= 1, `${name}: ≥1 image tile renders (${images})`);
  await snap(page, `${name}-rest`);

  // Enter edit mode via the "Edit" button.
  await page.getByRole("button", { name: "Edit" }).click();
  await page.waitForTimeout(300);
  assert(
    (await page.getByRole("button", { name: "Done" }).count()) === 1,
    `${name}: Edit button toggles to "Done"`,
  );
  await snap(page, `${name}-edit`);
  await page.close();
}

try {
  await captureViewport("desktop", { width: 1180, height: 900 }, undefined);
  await captureViewport("mobile", { width: 402, height: 874 }, 2);
} catch (err) {
  // A harness exception (not a page console error) — surface it as its own
  // failed assertion rather than mislabelling it a "page error".
  assert(false, `viewport capture threw: ${err}`);
}

// ── Video walkthrough: real interactions on a recorded mobile context ──────
const context = await browser.newContext({
  viewport: { width: 402, height: 874 },
  deviceScaleFactor: 2,
  recordVideo: { dir: videoDir, size: { width: 402, height: 874 } },
});
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForSelector('[data-testid="springboard"]');
await page.waitForTimeout(400);

// 1. Tap-launch a tile (first page tile that is not docked).
const launchTarget = "calendar";
await page.getByTestId(`springboard-tile-${launchTarget}`).getByRole("button").first().click();
await page.waitForTimeout(250);
const callsAfterLaunch = await readCalls(page);
assert(
  Array.isArray(callsAfterLaunch.launch) &&
    callsAfterLaunch.launch.includes(launchTarget),
  `tap launches the tile (onLaunch fired with "${launchTarget}")`,
);

// 2. Long-press a tile (450ms threshold) → enters edit mode.
await longPress(page, `springboard-tile-wallet`, 500);
await page.waitForTimeout(250);
assert(
  (await page.getByRole("button", { name: "Done" }).count()) === 1,
  "long-press (500ms) enters edit mode",
);

// 3. Toggle a favorite via the per-tile fav button (visible in edit mode).
await page.getByTestId("springboard-fav-calendar").click();
await page.waitForTimeout(250);

// 4. Page navigation — click the "Page 2" dot. Exit edit first (dots show in
//    both modes, but exit so the walkthrough ends on a clean grid).
await page.getByRole("button", { name: "Done" }).click();
await page.waitForTimeout(200);
const page2 = page.getByRole("button", { name: "Page 2" });
if ((await page2.count()) > 0) {
  await page2.click();
  await page.waitForTimeout(300);
  assert(true, "page navigation: clicked the Page 2 dot");
} else {
  assert(false, "page navigation: expected a Page 2 dot (multi-page layout)");
}

// 5. Real swipe-drag paging — the iOS-style gesture (not the dot), driving the
//    Framer drag="x" rail past SWIPE_THRESHOLD so onDragEnd commits a page flip.
//    Assert via the deterministic `page-swipe` telemetry the component emits on
//    a committed flick (the user reported left/right swipe felt broken). We're
//    on page 2 from the dot-nav above; swipe RIGHT → page 1, then LEFT → page 2.
async function swipeDrag(p, dx) {
  const box = await p.getByTestId("springboard").boundingBox();
  const y = box.y + box.height / 2;
  // Start off-centre so the drag has room to travel within the surface.
  const startX = box.x + box.width / 2 - Math.sign(dx) * box.width * 0.2;
  await p.mouse.move(startX, y);
  await p.mouse.down();
  await p.mouse.move(startX + dx, y, { steps: 12 });
  await p.mouse.up();
  await p.waitForTimeout(350);
}
const swipeCountBefore = (await readTelemetry(page)).filter(
  (e) => e.action === "page-swipe",
).length;
await swipeDrag(page, 220); // drag right → previous page
await swipeDrag(page, -220); // drag left → next page
const swipeCountAfter = (await readTelemetry(page)).filter(
  (e) => e.action === "page-swipe",
).length;
assert(
  swipeCountAfter > swipeCountBefore,
  `swipe-drag gesture commits a page flip (page-swipe telemetry ${swipeCountBefore}→${swipeCountAfter})`,
);

// ── Telemetry assertion — the real interaction stream fired ────────────────
const telemetry = await readTelemetry(page);
const actions = new Set(telemetry.map((e) => e.action));
assert(
  actions.has("launch"),
  `telemetry ring contains a launch action (${[...actions].join(", ")})`,
);
assert(
  actions.has("favorite"),
  `telemetry ring contains a favorite action (${[...actions].join(", ")})`,
);

assert(errors.length === 0, `no page errors (saw ${errors.length})`);
for (const e of errors) console.error(`  ⚠ ${e}`);

await page.close(); // flush the video
await context.close();
await browser.close();

// Rename the recorded video to a stable name.
const vids = (await readdir(videoDir)).filter((f) => f.endsWith(".webm"));
if (vids[0]) {
  await rename(join(videoDir, vids[0]), join(outDir, "springboard-walkthrough.webm"));
  console.log("  🎬 springboard-walkthrough.webm");
}

console.log(`\nScreenshots (${shot}) → ${outDir}`);
if (failures > 0) {
  console.error(`\nSPRINGBOARD E2E FAILED (${failures})`);
  process.exit(1);
}
console.log("\nSPRINGBOARD E2E PASSED");
process.exit(0);
