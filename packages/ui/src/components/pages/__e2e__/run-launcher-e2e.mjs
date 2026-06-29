/**
 * Real-browser e2e + screenshot + video for the Launcher view launcher —
 * no app server. Bundles launcher-fixture.tsx with esbuild, loads it in
 * headless chromium via Playwright, and:
 *
 *   - asserts the launcher + tiles render (≥1 tile, ≥1 image tile),
 *   - captures REST + EDIT screenshots at desktop (1180×900) and mobile
 *     (402×874),
 *   - records a .webm walkthrough driving REAL interactions: tap-launch a tile,
 *     long-press-to-edit (pointerdown + wait), page-nav,
 *   - reads window.__ELIZA_VIEW_INTERACTION_TELEMETRY__ and asserts a `launch`
 *     action fired — proving the client telemetry stream emits on real
 *     interactions (closing the telemetry-reader loop).
 *
 * Exits non-zero on any failed assertion or page error.
 *
 * Run: bun run --cwd packages/ui test:launcher-e2e
 */

import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-launcher");
const videoDir = join(outDir, "video");
await mkdir(outDir, { recursive: true });
await mkdir(videoDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// The tile hero-image resolver (ViewTileImage → resolveApiUrl) imports the
// @elizaos/shared barrel, which transitively reaches @elizaos/core / node
// builtins — all DEAD in the browser at render (the launcher renders from
// the fixture's hand-built entries; no API base is set so URLs pass through
// unchanged). Stub @elizaos/core to a no-op Proxy and every node builtin to a
// no-op module so the browser bundle builds, mirroring run-home-screen-e2e. If
// any of it actually ran at module load, the page-error guard below would catch
// it.
const stubElizaCore = {
  name: "stub-eliza-core",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/core$/ }, (args) => ({
      path: args.path,
      namespace: "eliza-core-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "eliza-core-stub" }, () => ({
      contents: `
        const noop = new Proxy(() => noop, { get: () => noop });
        module.exports = new Proxy(
          { isViewVisible: () => true, dedupeModalities: (m) => Array.from(new Set(Array.isArray(m) ? m : [])) },
          { get: (t, p) => (p in t ? t[p] : noop) },
        );
      `,
      loader: "js",
    }));
  },
};
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const bare = args.path.replace(/^node:/, "").split("/")[0];
      if (
        args.path.startsWith("node:") ||
        nodeBuiltins.has(args.path) ||
        builtinModules.includes(bare)
      ) {
        return { path: args.path, namespace: "node-stub" };
      }
      return null;
    });
    b.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents:
        "const n=()=>noop;const noop=new Proxy(n,{get:()=>noop});module.exports=noop;",
      loader: "js",
    }));
  },
};

const result = await build({
  entryPoints: [join(here, "launcher-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubElizaCore, stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
console.log(`✓ fixture bundled (${js.length} bytes)`);
const html = `<!doctype html><html><head><meta charset="utf-8"><title>launcher e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%;background:#0a0d16;color:#f4f4f5}</style>
<!-- Shim node-ish globals the dead-in-browser graph touches at module init. -->
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "launcher.html");
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
const readCalls = (p) => p.evaluate(() => window.__launcherCalls ?? {});

/** Edit mode pulses every tile (no pin badge anymore) — the editing signal. */
const editingTileCount = (p) =>
  p.evaluate(
    () =>
      document.querySelectorAll(
        '[data-testid^="launcher-tile-"] button.animate-pulse',
      ).length,
  );

const errors = [];
const browser = await chromium.launch();

// ── Screenshots: desktop + mobile, REST + EDIT ─────────────────────────────
async function captureViewport(name, viewport, deviceScaleFactor) {
  const page = await browser.newPage({ viewport, deviceScaleFactor });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForSelector('[data-testid="launcher"]');
  await page.waitForTimeout(400);

  const tiles = await page.locator('[data-testid^="launcher-tile-"]').count();
  assert(tiles >= 1, `${name}: ≥1 tile renders (${tiles})`);
  const images = await page
    .locator('[data-testid^="launcher-image-"]')
    .count();
  assert(images >= 1, `${name}: ≥1 image tile renders (${images})`);
  await snap(page, `${name}-rest`);

  // Enter edit mode via a long-press on a tile (the Edit button was removed —
  // long-press is the sole entry point now).
  await longPress(page, "launcher-tile-wallet", 500);
  await page.waitForTimeout(300);
  assert(
    (await editingTileCount(page)) > 0,
    `${name}: long-press enters edit mode (tiles pulse, no Edit button)`,
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
await page.waitForSelector('[data-testid="launcher"]');
await page.waitForTimeout(400);

// 1. Tap-launch a tile (first page tile that is not docked).
const launchTarget = "calendar";
await page.getByTestId(`launcher-tile-${launchTarget}`).getByRole("button").first().click();
await page.waitForTimeout(250);
const callsAfterLaunch = await readCalls(page);
assert(
  Array.isArray(callsAfterLaunch.launch) &&
    callsAfterLaunch.launch.includes(launchTarget),
  `tap launches the tile (onLaunch fired with "${launchTarget}")`,
);

// 2. Long-press a tile (450ms threshold) → enters edit mode.
await longPress(page, `launcher-tile-wallet`, 500);
await page.waitForTimeout(250);
assert(
  (await editingTileCount(page)) > 0,
  "long-press (500ms) enters edit mode (tiles pulse)",
);

// 3. Page navigation — click the "Page 2" dot. Exit edit first (a second
//    long-press toggles it off) so the walkthrough ends on a clean grid.
await longPress(page, `launcher-tile-wallet`, 500);
await page.waitForTimeout(250);
assert(
  (await editingTileCount(page)) === 0,
  "a second long-press exits edit mode",
);
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
  const box = await p.getByTestId("launcher").boundingBox();
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

assert(errors.length === 0, `no page errors (saw ${errors.length})`);
for (const e of errors) console.error(`  ⚠ ${e}`);

await page.close(); // flush the video
await context.close();
await browser.close();

// Rename the recorded video to a stable name.
const vids = (await readdir(videoDir)).filter((f) => f.endsWith(".webm"));
if (vids[0]) {
  await rename(join(videoDir, vids[0]), join(outDir, "launcher-walkthrough.webm"));
  console.log("  🎬 launcher-walkthrough.webm");
}

console.log(`\nScreenshots (${shot}) → ${outDir}`);
if (failures > 0) {
  console.error(`\nLAUNCHER E2E FAILED (${failures})`);
  process.exit(1);
}
console.log("\nLAUNCHER E2E PASSED");
process.exit(0);
