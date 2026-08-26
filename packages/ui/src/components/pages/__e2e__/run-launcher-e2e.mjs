/**
 * Real-browser e2e + screenshot + video for the Launcher view launcher —
 * no app server. Bundles launcher-fixture.tsx with esbuild, loads it in
 * headless chromium via Playwright, and:
 *
 *   - asserts the read-only launcher renders (>=1 tile, image-backed Ionicon
 *     or custom glyph visuals, no hero image nodes, no edit/pin/delete
 *     affordances, exactly one page),
 *   - captures dark + light rest screenshots at desktop (1180×900), plus dark
 *     hover/focus states, and dark rest/held-pointer states at the acceptance
 *     mobile viewport (390×844),
 *   - verifies hover and keyboard focus produce visible surface feedback while
 *     a held pointer produces no animation, transform, or geometry movement,
 *   - records a .webm walkthrough driving REAL interactions: tap-launch a tile,
 *     a stationary long-press (which must NOT enter any edit mode), and a
 *     right-swipe that requests a return to the home dashboard,
 *   - reads window.__ELIZA_VIEW_INTERACTION_TELEMETRY__ and asserts a `launch`
 *     action fired — proving the client telemetry stream emits on real
 *     interactions (closing the telemetry-reader loop).
 *
 * Exits non-zero on any failed assertion or page error.
 *
 * Run: bun run --cwd packages/ui test:launcher-e2e
 */

import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { compileTailwindTheme } from "../../../testing/e2e-runner/fixture-bundle.ts";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, "../../../..");
const outDir = join(here, "output-launcher");
const videoDir = join(outDir, "video");
// Every run owns this one explicit generated-artifact directory. Start clean so
// screenshots and the randomly named Playwright video cannot come from an
// earlier invocation.
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await mkdir(videoDir, { recursive: true });
// The production bundler resolves new URL(..., import.meta.url) asset paths.
// This self-contained browser fixture emits an inline ESM bundle instead, so
// mirror the source-relative directory next to launcher.html for the same URL
// contract and for screenshots that exercise actual loaded SVGs.
await cp(
  join(here, "../../views/view-icons/ionicons"),
  join(outDir, "view-icons/ionicons"),
  { recursive: true, force: true },
);

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
        // The wake/provision path (client-cloud.ts) subclasses the real
        // ElizaError; esbuild's ESM interop copies only this object's own keys,
        // so a Proxy fallback would surface undefined here and break the
        // subclass at evaluation time. Export a real class with core's shape so
        // the fixture bundle exercises the same error type production does.
        class ElizaError extends Error {
          constructor(message, options = {}) {
            super(
              message,
              options.cause !== undefined ? { cause: options.cause } : undefined,
            );
            this.name = "ElizaError";
            this.code = options.code;
            this.context = options.context;
            this.severity = options.severity;
            Object.setPrototypeOf(this, new.target.prototype);
          }
        }
        module.exports = new Proxy(
          { ElizaError, isElizaError: (v) => v instanceof ElizaError, isViewVisible: () => true, dedupeModalities: (m) => Array.from(new Set(Array.isArray(m) ? m : [])) },
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
  // Keep import.meta.url intact for the Ionicon asset resolver.
  format: "esm",
  platform: "browser",
  conditions: ["eliza-source", "browser"],
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubElizaCore, stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
console.log(`✓ fixture bundled (${js.length} bytes)`);
// Compile the real UI theme rather than relying on the approximate CDN v3
// runtime. The shared helper intentionally omits product-shell policy rules,
// so extract the owning focus block from styles.css and append it verbatim.
// This makes the keyboard assertion exercise the shipped no-UA-ring policy as
// well as the launcher's filled focus surface.
const themeCss = await compileTailwindTheme({
  uiRoot,
  sources: [
    join(uiRoot, "src/components/pages"),
    join(uiRoot, "src/components/shell"),
    join(uiRoot, "src/components/ui"),
    join(uiRoot, "src/components/views"),
    here,
  ],
});
const productCss = await readFile(join(uiRoot, "src/styles/styles.css"), "utf8");
const focusPolicyStart = productCss.indexOf(
  "/* Product policy: focus rings are intentionally disabled globally. */",
);
const focusPolicyEndMarker =
  "/* biome-ignore-end lint/complexity/noImportantStyles: end focus-ring ban override */";
const focusPolicyEnd = productCss.indexOf(
  focusPolicyEndMarker,
  focusPolicyStart,
);
if (focusPolicyStart < 0 || focusPolicyEnd < 0) {
  throw new Error("could not find the product focus-policy block in styles.css");
}
const focusPolicyCss = productCss.slice(
  focusPolicyStart,
  focusPolicyEnd + focusPolicyEndMarker.length,
);
const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>launcher e2e</title>
<style>${themeCss}\n${focusPolicyCss}\nhtml,body{margin:0;height:100%;background:#0a0d16;color:#f4f4f5}</style>
<!-- Shim node-ish globals the dead-in-browser graph touches at module init. -->
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
</head><body><div id="root"></div><script type="module">${js}</script></body></html>`;
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

const readTelemetry = (p) =>
  p.evaluate(() => window.__ELIZA_VIEW_INTERACTION_TELEMETRY__ ?? []);
const readCalls = (p) => p.evaluate(() => window.__launcherCalls ?? {});

// Compare paint owned by the launcher state itself. Its inset depth must remain
// stable under pointer focus even though the product-wide focus reset removes
// ordinary descendant shadows.
const SURFACE_PROPERTIES = ["backgroundColor", "borderColor", "boxShadow"];
const GEOMETRY_PROPERTIES = ["x", "y", "width", "height"];

function surfaceChanged(before, after) {
  return SURFACE_PROPERTIES.some(
    (property) => before[property] !== after[property],
  );
}

function geometryStayedPut(before, after, tolerance = 0.5) {
  return GEOMETRY_PROPERTIES.every(
    (property) => Math.abs(before[property] - after[property]) <= tolerance,
  );
}

function hasNeutralMotion(state) {
  return Object.values(state.parts).every(
    (part) => part.transform === "none" && part.animationName === "none",
  );
}

async function readTileState(button) {
  return button.evaluate((element) => {
    const plate = element.querySelector("[data-launcher-icon]");
    const glyph = element.querySelector("[data-launcher-glyph]");
    if (!(plate instanceof HTMLElement) || !(glyph instanceof HTMLElement)) {
      throw new Error("launcher tile is missing its icon plate or glyph");
    }

    const readPart = (part) => {
      const style = getComputedStyle(part);
      const rect = part.getBoundingClientRect();
      return {
        animationName: style.animationName,
        transform: style.transform,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      };
    };
    const plateStyle = getComputedStyle(plate);

    return {
      focusVisible: element.matches(":focus-visible"),
      surface: {
        backgroundColor: plateStyle.backgroundColor,
        borderColor: plateStyle.borderColor,
        boxShadow: plateStyle.boxShadow,
      },
      parts: {
        button: readPart(element),
        plate: readPart(plate),
        glyph: readPart(glyph),
      },
      activeAnimations: element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === "running").length,
    };
  });
}

function tileGeometryStayedPut(before, after) {
  return Object.keys(before.parts).every((part) =>
    geometryStayedPut(before.parts[part].rect, after.parts[part].rect),
  );
}

const errors = [];
const browser = await chromium.launch();

// ── Screenshots: desktop + mobile ──────────────────────────────────────────
// The launcher is a read-only single scrolling page of tiles (no edit mode, no
// pagination), so there is one "rest" capture per viewport.
async function captureViewport(
  name,
  viewport,
  deviceScaleFactor,
  { theme = "dark", interactions = false } = {},
) {
  const page = await browser.newPage({ viewport, deviceScaleFactor });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  await page.evaluate((mode) => {
    document.documentElement.classList.toggle("dark", mode === "dark");
  }, theme);
  await page.waitForSelector('[data-testid="launcher"]');
  await page.waitForTimeout(400);

  const renderedColorScheme = await page.evaluate(
    () => getComputedStyle(document.documentElement).colorScheme,
  );
  assert(
    renderedColorScheme === theme,
    `${name}: real theme CSS renders in ${theme} mode (color-scheme=${renderedColorScheme})`,
  );

  const tiles = await page.locator('[data-testid^="launcher-tile-"]').count();
  assert(tiles >= 1, `${name}: >=1 tile renders (${tiles})`);
  const visuals = await page.locator("[data-view-visual]").count();
  assert(
    visuals === tiles,
    `${name}: every launcher tile has a glyph visual (${visuals}/${tiles})`,
  );
  const glyphImages = await page
    .locator("[data-view-visual] img[data-launcher-glyph]")
    .count();
  assert(
    glyphImages === tiles,
    `${name}: every launcher visual uses one glyph image (${glyphImages}/${tiles})`,
  );
  const ionicons = await page
    .locator(
      '[data-launcher-glyph-kind="ionicon"][data-ionicon]:not([data-ionicon=""])',
    )
    .count();
  const ioniconsLoaded = await page
    .locator('[data-launcher-glyph-kind="ionicon"]')
    .evaluateAll((images) =>
      images.every(
        (image) =>
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth > 0,
      ),
    );
  const customImages = await page
    .locator(
      '[data-launcher-glyph-kind="image"]:not([data-ionicon]):not([data-testid^="launcher-image-"])',
    )
    .count();
  assert(ionicons >= 1, `${name}: official Ionicon assets render (${ionicons})`);
  assert(ioniconsLoaded, `${name}: every Ionicon SVG asset loads successfully`);
  // A third-party icon URL is also an <img>, but its resolver kind is `image`
  // and it deliberately has no data-ionicon attribute. Accept both outcomes
  // while rejecting an unclassified image, so a third-party fixture remains
  // compatible.
  assert(
    ionicons + customImages === glyphImages,
    `${name}: glyph images are Ionicon or third-party custom assets (ionicon=${ionicons}, custom=${customImages})`,
  );
  const heroImages = await page
    .locator('[data-testid^="launcher-image-"]')
    .count();
  assert(
    heroImages === 0,
    `${name}: no launcher hero image nodes render (${heroImages})`,
  );
  const uncontractedImages = await page
    .locator("[data-view-visual] img:not([data-launcher-glyph])")
    .count();
  assert(
    uncontractedImages === 0,
    `${name}: no image bypasses the launcher glyph contract (${uncontractedImages})`,
  );
  for (const entryWithHero of ["wallet", "companion"]) {
    const deterministicGlyph = await page
      .getByTestId(`launcher-tile-${entryWithHero}`)
      .locator("[data-launcher-glyph]")
      .count();
    assert(
      deterministicGlyph === 1,
      `${name}: ${entryWithHero} ignores its hero URL and keeps one deterministic glyph`,
    );
  }
  // Read-only: no per-tile edit/pin/delete affordances anywhere.
  const editAffordances = await page
    .locator(
      '[data-testid^="launcher-fav-"], [data-testid^="launcher-edit-"], [data-testid^="launcher-delete-"]',
    )
    .count();
  assert(
    editAffordances === 0,
    `${name}: read-only launcher renders no edit/pin/delete affordances (${editAffordances})`,
  );
  // Single scrolling page: one page window, no inter-page view paging.
  const pageWindow = await page.getByTestId("launcher-page-window").count();
  const legacyPage1 = await page.getByTestId("launcher-page-1").count();
  assert(
    pageWindow === 1 && legacyPage1 === 0,
    `${name}: single launcher page window (window=${pageWindow}, legacy-page-1=${legacyPage1})`,
  );
  await snap(page, `${name}-rest`);

  if (interactions) {
    const firstTile = page
      .getByTestId("launcher-tile-chat")
      .getByRole("button");
    const restState = await readTileState(firstTile);

    await firstTile.hover();
    await page.waitForTimeout(250);
    const hoverState = await readTileState(firstTile);
    assert(
      surfaceChanged(restState.surface, hoverState.surface),
      `${name}: hover visibly changes the icon surface`,
    );
    assert(
      tileGeometryStayedPut(restState, hoverState),
      `${name}: hover feedback does not move or resize the tile`,
    );
    await snap(page, `${name}-hover`);

    await page.mouse.move(1, 1);
    await page.waitForTimeout(250);
    const unfocusedState = await readTileState(firstTile);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(100);
    const focusState = await readTileState(firstTile);
    const focusedTestId = await page.evaluate(
      () =>
        document.activeElement
          ?.closest("[data-testid]")
          ?.getAttribute("data-testid") ?? null,
    );
    assert(
      focusedTestId === "launcher-tile-chat" && focusState.focusVisible,
      `${name}: Tab puts visible keyboard focus on the first launcher tile`,
    );
    assert(
      surfaceChanged(unfocusedState.surface, focusState.surface),
      `${name}: keyboard focus visibly changes the icon surface`,
    );
    assert(
      tileGeometryStayedPut(unfocusedState, focusState),
      `${name}: keyboard focus feedback does not move or resize the tile`,
    );
    await snap(page, `${name}-keyboard-focus`);
  }
  await page.close();
}

try {
  await captureViewport(
    "desktop-dark",
    { width: 1180, height: 900 },
    undefined,
    { theme: "dark", interactions: true },
  );
  await captureViewport(
    "desktop-light",
    { width: 1180, height: 900 },
    undefined,
    { theme: "light" },
  );
  await captureViewport(
    "mobile-dark",
    { width: 390, height: 844 },
    2,
    { theme: "dark" },
  );
} catch (err) {
  // A harness exception (not a page console error) — surface it as its own
  // failed assertion rather than mislabelling it a "page error".
  assert(false, `viewport capture threw: ${err}`);
}

// ── Video walkthrough: real interactions on a recorded mobile context ──────
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  recordVideo: { dir: videoDir, size: { width: 390, height: 844 } },
});
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForSelector('[data-testid="launcher"]');
await page.waitForTimeout(400);

// 1. Tap-launch a tile from the read-only grid.
const launchTarget = "calendar";
await page.getByTestId(`launcher-tile-${launchTarget}`).getByRole("button").first().click();
await page.waitForTimeout(250);
const callsAfterLaunch = await readCalls(page);
assert(
  Array.isArray(callsAfterLaunch.launch) &&
    callsAfterLaunch.launch.includes(launchTarget),
  `tap launches the tile (onLaunch fired with "${launchTarget}")`,
);
const launchInRing = (await readTelemetry(page)).some(
  (e) => e.action === "launch",
);
assert(launchInRing, "telemetry ring recorded the tap launch");

// 2. A stationary long-press does NOT enter any edit mode (read-only launcher).
//    Sample computed rendering before, shortly after pointer-down, and past the
//    hold threshold: neither button, plate, nor glyph may animate, transform,
//    or move. The held release must also be consumed rather than ghost-launch.
{
  const tile = page.getByTestId("launcher-tile-wallet").getByRole("button");
  const box = await tile.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(250);
  const beforePress = await readTileState(tile);
  await page.mouse.down();
  await page.waitForTimeout(80);
  const afterPointerDown = await readTileState(tile);
  await page.waitForTimeout(520);
  const whileHeld = await readTileState(tile);
  await snap(page, "mobile-long-press-held");
  await page.mouse.up();
  await page.waitForTimeout(150);
  assert(
    hasNeutralMotion(beforePress) &&
      hasNeutralMotion(afterPointerDown) &&
      hasNeutralMotion(whileHeld) &&
      afterPointerDown.activeAnimations === 0 &&
      whileHeld.activeAnimations === 0,
    "pointer-down and long-press add no animation or transform to the tile",
  );
  assert(
    tileGeometryStayedPut(beforePress, afterPointerDown) &&
      tileGeometryStayedPut(beforePress, whileHeld),
    "pointer-down and long-press do not move or resize the button, plate, or glyph",
  );
  assert(
    !surfaceChanged(beforePress.surface, afterPointerDown.surface) &&
      !surfaceChanged(beforePress.surface, whileHeld.surface),
    "pointer-down and long-press keep launcher-owned paint and inset depth stable",
  );
  const affordances = await page
    .locator(
      '[data-testid^="launcher-fav-"], [data-testid^="launcher-edit-"], [data-testid^="launcher-delete-"], button.animate-pulse',
    )
    .count();
  assert(
    affordances === 0,
    `a long-press never enters edit mode (read-only launcher; ${affordances} affordances)`,
  );
  const callsAfterHold = await readCalls(page);
  assert(
    !Array.isArray(callsAfterHold.launch) ||
      !callsAfterHold.launch.includes("wallet"),
    "a long-press release does not ghost-launch the held tile",
  );
}

// 3. A right-swipe on the launcher rides the OUTER home↔launcher rail back to
//    the home dashboard, tracking the pointer 1:1 mid-drag (the iOS feel: the
//    rail moves with the finger, not a damped rubber-band). The single-page
//    inner launcher pager owns no horizontal gesture.
{
  const win = page.getByTestId("launcher-page-window");
  const box = await win.boundingBox();
  const y = box.y + box.height * 0.5;
  const startX = box.x + box.width * 0.15;
  const dragPx = Math.round(box.width * 0.3);
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX + dragPx, y, { steps: 8 });
  // Mid-drag: the rail must track the finger 1:1 — resting offset is -width
  // (launcher page), so after a +dragPx drag it sits at -(width - dragPx).
  const midDrag = await page.evaluate(() => {
    const rail = document.querySelector('[data-testid="home-launcher-rail"]');
    if (!(rail instanceof HTMLElement)) return null;
    return new DOMMatrixReadOnly(getComputedStyle(rail).transform).m41;
  });
  const expectedMid = -(box.width - dragPx);
  assert(
    midDrag !== null && Math.abs(midDrag - expectedMid) <= 2,
    `mid-drag rail tracks the pointer 1:1 (m41=${midDrag}, expected ≈${expectedMid})`,
  );
  // Finish past the 50% commit point and release.
  await page.mouse.move(startX + Math.round(box.width * 0.6), y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const railPage = await page
    .getByTestId("home-launcher-surface")
    .getAttribute("data-page");
  assert(railPage === "home", `right-swipe rides the rail home (data-page=${railPage})`);
  await snap(page, "mobile-after-swipe-home");
}

assert(errors.length === 0, `no page errors (saw ${errors.length})`);
for (const e of errors) console.error(`  ⚠ ${e}`);

await page.close(); // flush the video
await context.close();
await browser.close();

// Rename the recorded video to a stable name.
const vids = (await readdir(videoDir)).filter((f) => f.endsWith(".webm"));
assert(
  vids.length === 1,
  `walkthrough emits exactly one video artifact (${vids.length})`,
);
if (vids.length === 1) {
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
