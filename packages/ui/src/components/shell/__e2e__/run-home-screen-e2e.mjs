/**
 * Real-browser screenshot e2e for the iOS-style HomeScreen — no app server.
 * Bundles home-screen-fixture.tsx with esbuild (stubbing the data sources), loads
 * it in headless chromium, and asserts the Home/Launcher consolidation +
 * captures mobile + desktop screenshots plus a mobile interaction recording.
 *
 * Run: bun run --cwd packages/ui test:home-screen-e2e
 */

import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import {
  FRAME_SAMPLER_INIT,
  shouldReportFrameBudget,
  summarizeFrameSamples,
} from "../../../hooks/frame-budget.ts";
import {
  LAYOUT_SHIFT_OBSERVER_INIT,
  summarizeStability,
} from "../../../testing/layout-stability.ts";
import {
  touchLongPress,
  touchSwipe,
} from "../../../testing/real-touch-gestures.ts";

// Frame gate for the home↔launcher rail swipe — same factor-based thresholds as
// the sibling real-overlay gates (run-perf-gate-e2e / run-chat-perf-gate): the
// budget adapts to the runner's refresh rate instead of hard-coding a Hz.
const FRAME_BUDGET = { targetFps: 60 };
const FRAME_GATE = {
  p95BudgetFactor: 2,
  droppedFrameRatio: 0.2,
  reportOnLongTask: false,
};
const MIN_FRAME_SAMPLES = 30;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-home");
await mkdir(outDir, { recursive: true });
const RECORDED_VIDEO_FILE = "mobile-launcher-flow.webm";

async function clearGeneratedVideoArtifacts() {
  await rm(join(outDir, RECORDED_VIDEO_FILE), { force: true });
  for (const entry of await readdir(outDir)) {
    if (/^page@.+\.webm$/.test(entry)) {
      await rm(join(outDir, entry), { force: true });
    }
  }
}

function stripTrailingLineWhitespace(text) {
  return text.replace(/[ \t]+$/gm, "");
}

await clearGeneratedVideoArtifacts();

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// Redirect the live data sources to deterministic stubs.
const stubResolver = {
  name: "home-stub-resolver",
  setup(b) {
    // HomeScreen mounts the REAL unified home-slot WidgetHost (#9143). It resolves
    // its per-plugin widgets from the app-store plugins snapshot and renders them
    // with injected data (seeded in home-screen-fixture.tsx). The data sources —
    // the `client` (relationships + base URL) and `window.fetch` (lifeops routes)
    // — are stubbed below / in the fixture; the WidgetHost + widget components
    // themselves are NOT stubbed.
    b.onResolve({ filter: /(\/api|\/api\/client)$/ }, () => ({
      path: join(here, "home-screen-fixture.api-stub.ts"),
    }));
    b.onResolve({ filter: /useActivityEvents$/ }, () => ({
      path: join(here, "home-screen-fixture.activity-stub.ts"),
    }));
    b.onResolve({ filter: /useDocumentVisibility$/ }, () => ({
      path: join(here, "home-screen-fixture.docvis-stub.ts"),
    }));
    b.onResolve({ filter: /useAvailableViews$/ }, () => ({
      path: join(here, "home-screen-fixture.views-stub.ts"),
    }));
    b.onResolve({ filter: /useViewCatalog$/ }, () => ({
      path: join(here, "home-screen-fixture.catalog-stub.ts"),
    }));
    b.onResolve({ filter: /useViewKinds$/ }, () => ({
      path: join(here, "home-screen-fixture.view-kinds-stub.ts"),
    }));
    b.onResolve({ filter: /platform-guards$/ }, () => ({
      path: join(here, "home-screen-fixture.platform-stub.ts"),
    }));
    // Since #11084 (#11107/#11122) the widget pollers gate on
    // useIsAuthenticated(); the fixture has no auth backend, so present an
    // authenticated local session or every gated widget stays dormant and
    // self-hides (see the auth-stub header).
    b.onResolve({ filter: /\/hooks\/useAuthStatus$/ }, () => ({
      path: join(here, "home-screen-fixture.auth-stub.ts"),
    }));
    // The widget components reach the hooks barrel only for
    // `useIntervalWhenDocumentVisible` (verified: every bare `../../../hooks`
    // import in the widget files takes only that hook). The barrel itself drags
    // in the whole app-state surface (@elizaos/shared, AppContext, …) which is
    // dead weight here, so sever it at the barrel with a no-op interval hook.
    b.onResolve({ filter: /\/hooks$/ }, () => ({
      path: join(here, "home-screen-fixture.docvis-stub.ts"),
    }));
  },
};

// @elizaos/core: the WidgetHost + the (dead-in-browser) @elizaos/shared graph
// import a wide named surface from it. Satisfy ANY named import with a no-op
// Proxy, but override the handful the render path actually uses with REAL
// implementations. These must be OWN enumerable keys of the exported object —
// esbuild's __toESM interop only copies own keys onto the ESM namespace, so a
// value reachable only through the Proxy `get` trap reads back as undefined
// ("resolveViewKind is not a function"). The launcher curation drives real
// developer/preview gating, so it needs the genuine view-kind helpers.
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
        const resolveViewKind = (d) =>
          (d && d.viewKind) || (d && d.developerOnly ? "developer" : "release");
        const isViewKindEnabled = (kind, enabled) =>
          kind === "system" || kind === "release"
            ? true
            : kind === "developer"
              ? !!(enabled && enabled.developer)
              : kind === "preview"
                ? !!(enabled && enabled.preview)
                : false;
        module.exports = new Proxy(
          {
            resolveViewKind,
            isViewKindEnabled,
            isViewVisible: (d, enabled) =>
              isViewKindEnabled(resolveViewKind(d), enabled),
            dedupeModalities: (m) => Array.from(new Set(Array.isArray(m) ? m : [])),
          },
          { get: (t, p) => (p in t ? t[p] : noop) },
        );
      `,
      loader: "js",
    }));
  },
};

// The REAL WidgetHost subtree transitively reaches server-only code (the hooks
// barrel pulls @elizaos/logger / @elizaos/shared, which import node builtins) —
// DEAD in the browser (never executed at render; the home widgets fetch through
// the mocked window.fetch + the stubbed client). Stub every node builtin to a
// no-op Proxy so the browser bundle builds; if any of it actually ran at module
// load the page-error guard below would catch it. (Mirrors run-chat-sheet-e2e.)
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
  entryPoints: [join(here, "home-screen-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubResolver, stubElizaCore, stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
const html = stripTrailingLineWhitespace(`<!doctype html><html><head><meta charset="utf-8"><title>home screen e2e</title>
<!-- Match the real app's viewport (packages/app/index.html): without it a
     mobile page falls back to the 980px layout viewport, so CSS \`vw\` units
     (the sheet's \`w-[min(440px,100vw-1rem)]\`) mis-measure and the overlay
     mis-centers — a test-only artifact that hid the real overlay geometry. -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%;background:#0a0d16}
:root{--eliza-continuous-chat-clearance:5.25rem;--safe-area-bottom:0px;--eliza-mobile-nav-offset:0px}</style>
<!-- Shim node-ish globals some of the dead-in-browser graph touches at module
     init (e.g. \`process.env\`). The real code paths never execute at render. -->
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
</head><body><div id="root"></div><script>${js}</script></body></html>`);
const htmlPath = join(outDir, "home-screen.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

const sink = { errors: [] };
const browser = await chromium.launch();
let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}
// Mouse-drag paging for the DESKTOP page only (its context has no touch
// support, and dragging the rail with a mouse is the real desktop input).
// Every mobile-context swipe below goes through real CDP touch instead.
async function swipeLeft(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("missing swipe target bounds");
  const y = box.y + box.height * 0.45;
  const startX = box.x + box.width * 0.78;
  const endX = box.x + box.width * 0.22;
  await locator.page().mouse.move(startX, y);
  await locator.page().mouse.down();
  await locator.page().mouse.move(endX, y, { steps: 8 });
  await locator.page().mouse.up();
}
// Horizontal touch-swipes across an element, driven through Chromium's real
// touch input path. These keep the mobile pagers honest — the inner launcher
// pager AND the outer home↔launcher rail: hit-testing, touch-action, implicit
// capture, and pointer cancellation all stay in play.
async function touchSwipeLeft(page, testId) {
  await touchSwipe(page, `[data-testid="${testId}"]`, -280, 0, {
    steps: 10,
    stepDelayMs: 16,
  });
}
async function touchSwipeRight(page, testId) {
  await touchSwipe(page, `[data-testid="${testId}"]`, 280, 0, {
    steps: 10,
    stepDelayMs: 16,
  });
}
// A real downward touch drag — the home notification pull-down (#10706) is a
// vertical gesture, so this drives it through the same CDP touch path as the
// horizontal rail swipes.
async function touchSwipeDown(page, testId, dy = 180) {
  await touchSwipe(page, `[data-testid="${testId}"]`, 0, dy, {
    steps: 12,
    stepDelayMs: 16,
  });
}

// A STATIONARY hold past the long-press window. On the curated launcher this
// must NOT enter edit mode (the launcher is read-only, fixed placement).
async function longPressHold(page, tileTestId) {
  await touchLongPress(page, `[data-testid="${tileTestId}"] button`, 600);
}
async function waitForSurfacePageSettled(p, pageName) {
  await p.waitForFunction((expectedPage) => {
    const surface = document.querySelector(
      '[data-testid="home-launcher-surface"]',
    );
    const rail = document.querySelector(
      '[data-testid="home-launcher-rail"]',
    );
    if (!(surface instanceof HTMLElement) || !(rail instanceof HTMLElement)) {
      return false;
    }
    if (surface.getAttribute("data-page") !== expectedPage) return false;
    const surfaceRect = surface.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const expectedLeft =
      expectedPage === "launcher"
        ? surfaceRect.left - surfaceRect.width
        : surfaceRect.left;
    const railSettled = Math.abs(railRect.left - expectedLeft) < 1;
    const transitionsDone = rail
      .getAnimations()
      .every((animation) => animation.playState === "finished");
    return railSettled && transitionsDone;
  }, pageName);
}
try {
  // Mobile (Pixel-ish) — the primary target.
  const mobileContext = await browser.newContext({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    recordVideo: {
      dir: outDir,
      size: { width: 402, height: 874 },
    },
  });
  const mobile = await mobileContext.newPage();
  mobile.on("pageerror", (e) => sink.errors.push(String(e)));
  await mobile.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    const coarsePointer = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    });
    window.matchMedia = (query) =>
      /hover:\s*hover|pointer:\s*fine/.test(query)
        ? coarsePointer(query)
        : real(query);
  });
  // Install the shared layout-shift PerformanceObserver BEFORE any paint, so
  // every shift during the home settle lands in window.__ELIZA_LAYOUT_SHIFTS__
  // (the same contract HomeScreen's dev observer + the KPI specs use). We read
  // it after the entrance animation finishes and assert the home doesn't jump
  // (CLS budget + no flicker flash) via the meta-tested summarizeStability.
  await mobile.addInitScript(LAYOUT_SHIFT_OBSERVER_INIT);
  // Frame sampler for the rail-swipe FPS gate below (start()/read()/stop()).
  await mobile.addInitScript(FRAME_SAMPLER_INIT);
  await mobile.goto(`${url}?native`);
  await mobile.waitForSelector('[data-testid="home-launcher-surface"]');
  await mobile.waitForSelector('[data-testid="home-screen"]');
  await mobile.waitForTimeout(600);
  assert(
    (await mobile.getByTestId("rail-pager-edge-prev").count()) === 0 &&
      (await mobile.getByTestId("rail-pager-edge-next").count()) === 0 &&
      (await mobile.getByTestId("launcher-pager-edge-prev").count()) === 0 &&
      (await mobile.getByTestId("launcher-pager-edge-next").count()) === 0,
    "mobile coarse-pointer: no rail or launcher edge buttons on home",
  );
  assert(
    (await mobile.getByTestId("home-launcher-surface").getAttribute(
      "data-page",
    )) === "home",
    "combined surface starts on Home",
  );
  assert(
    (await mobile.getByTestId("home-clock").count()) === 0,
    "no clock (home kept minimal)",
  );
  // The home mounts the REAL unified home-slot WidgetHost (#9143) — the
  // prioritized dynamic-priority home widgets — fed by the injected mock data
  // (seeded in the fixture). Assert the host is mounted AND that each seeded
  // per-plugin widget card renders its populated content (each self-hides when
  // empty, so visibility proves the data flowed through real widget components).
  const homeWidgetHost = mobile.getByTestId("widget-host-home");
  await mobile.waitForSelector('[data-testid="widget-host-home"]');
  assert((await homeWidgetHost.count()) === 1, "home WidgetHost is present");
  assert(
    (await homeWidgetHost.getAttribute("data-slot")) === "home",
    "home WidgetHost is mounted for the home slot",
  );
  // Wait for the staggered home-enter fade-up to settle so the cards are fully
  // opaque (and the data-driven cards have mounted + fetched) before asserting.
  await mobile.waitForFunction(
    () => {
      const home = document.querySelector('[data-testid="home-screen"]');
      if (!home) return false;
      return !home
        .getAnimations({ subtree: true })
        .some((a) => a.animationName === "home-enter" && a.playState !== "finished");
    },
    undefined,
    { timeout: 5000 },
  );
  // Each per-plugin home widget renders only when its injected data is
  // attention-worthy — visibility is the proof the REAL widget parsed the data.
  const WIDGET_CARDS = [
    ["chat-widget-finances-alerts", "Overdrawn"],
    ["widget-goals-attention", "Ship the release"],
    ["widget-notifications", "Payment failed"],
    ["chat-widget-relationships", null],
    ["chat-widget-calendar-upcoming", "Design review"],
    ["widget-health-sleep", "Irregular"],
    ["chat-widget-inbox-unread", "Alex Rivera"],
  ];
  for (const [testId, text] of WIDGET_CARDS) {
    const card = homeWidgetHost.getByTestId(testId);
    await card.first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    assert((await card.count()) > 0, `home widget ${testId} renders`);
    if (text) {
      assert(
        (await homeWidgetHost.getByText(text, { exact: false }).count()) > 0,
        `home widget ${testId} shows "${text}"`,
      );
    }
  }
  // No home widget may fall back to the "Widget failed to render" boundary — an
  // ErrorBoundary catch is invisible to the page-error guard, so assert it here.
  {
    const errorCards = await mobile
      .locator('[data-testid^="widget-error-"]')
      .allTextContents();
    assert(
      errorCards.length === 0,
      `no home widget hit its error boundary (${errorCards.length})`,
    );
  }
  // No general quick-access tiles anymore — Launcher is the adjacent
  // launcher. The only tiles left are the AOSP native-OS surfaces, shown here
  // because the mobile page sets ?native (see HomeScreen.tsx HOME_TILES).
  for (const id of ["messages", "phone", "contacts", "camera"]) {
    assert(
      await mobile.getByTestId(`home-tile-${id}`).isVisible(),
      `native-OS tile ${id} renders (native enabled)`,
    );
  }
  // The removed defaults must NOT appear, even with native enabled.
  for (const id of ["tutorial", "help", "settings", "views"]) {
    assert(
      (await mobile.getByTestId(`home-tile-${id}`).count()) === 0,
      `removed default tile ${id} is gone`,
    );
  }
  // Home-grid geometry integrity (#11752). Every widget must apply its
  // host-supplied grid-span classes to its root grid item; a widget that
  // drops them collapses to a one-column (~85px) auto-placed cell whose
  // icon+text flex content overflows the cell and paints over the neighboring
  // card ("Overdr[icon]wn" collisions). Measure the real boxes: each grid
  // item's painted content must fit its own cell, and no two items' painted
  // content may intersect.
  {
    const TOLERANCE = 1; // px, subpixel rounding
    const geometry = await mobile.evaluate(() => {
      const host = document.querySelector('[data-testid="widget-host-home"]');
      if (!host) return null;
      return Array.from(host.children).map((el) => {
        const rect = el.getBoundingClientRect();
        // Painted-content box: the union of the item's own border box and every
        // visible descendant box (overflowing flex children extend past it).
        let { left, right, top, bottom } = rect;
        for (const descendant of el.querySelectorAll("*")) {
          const r = descendant.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          left = Math.min(left, r.left);
          right = Math.max(right, r.right);
          top = Math.min(top, r.top);
          bottom = Math.max(bottom, r.bottom);
        }
        return {
          testId:
            el.getAttribute("data-testid") ||
            el
              .querySelector("[data-testid]")
              ?.getAttribute("data-testid") ||
            el.tagName.toLowerCase(),
          overflowX: el.scrollWidth - el.clientWidth,
          content: { left, right, top, bottom },
        };
      });
    });
    assert(geometry !== null, "home WidgetHost present for geometry probe");
    assert(
      (geometry ?? []).length > 1,
      `home grid geometry probe sees multiple widgets (${geometry?.length ?? 0})`,
    );
    for (const item of geometry ?? []) {
      assert(
        item.overflowX <= TOLERANCE,
        `home widget ${item.testId} content fits its grid cell (overflow ${item.overflowX}px)`,
      );
    }
    const items = geometry ?? [];
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i].content;
        const b = items[j].content;
        const xOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const yOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        assert(
          !(xOverlap > TOLERANCE && yOverlap > TOLERANCE),
          `home widgets ${items[i].testId} and ${items[j].testId} do not overlap (x ${Math.round(xOverlap)}px, y ${Math.round(yOverlap)}px)`,
        );
      }
    }
  }
  await snap(mobile, "mobile-home");

  // Layout-stability lock (#9304): the home cards rank + self-hide; a ranking
  // reorder or a card popping in must NOT jump the page. `contain: layout` on
  // the WidgetHost + the once-only entrance fade keep the settle stable. Read
  // the observed layout-shifts and assert the meta-tested summarizer doesn't
  // flag the home settle (CLS under the Web-Vitals "good" budget, no flash).
  const shifts = await mobile.evaluate(
    () => window.__ELIZA_LAYOUT_SHIFTS__ ?? [],
  );
  const stability = summarizeStability(shifts, [], { maxCls: 0.1 });
  assert(
    !stability.flagged,
    `home settle is layout-stable (CLS ${stability.cls.toFixed(4)} ≤ 0.1, ${stability.shiftCount} shifts)`,
  );

  // Real touch pull-DOWN on the notification zone opens the NotificationCenter
  // sheet (#10706) — previously only jsdom synthetic pointer events covered it.
  assert(
    (await mobile.getByTestId("notification-sheet-close").count()) === 0,
    "notification sheet starts closed",
  );
  await touchSwipeDown(mobile, "home-notification-pull-zone");
  await mobile
    .getByTestId("notification-sheet-close")
    .waitFor({ state: "visible", timeout: 4000 });
  assert(
    await mobile.getByTestId("notification-sheet-close").isVisible(),
    "real-touch pull-down opens the notification sheet",
  );
  // On-screen + horizontally centered: the sheet must sit within the viewport,
  // not clipped to one side. (A `position: fixed` sheet trapped in the
  // transformed home↔launcher rail anchors to the 2×-wide rail and renders
  // half-off-screen to the right — this catches that regression.)
  {
    const sheetBox = await mobile.getByTestId("notification-sheet").boundingBox();
    const vw = mobile.viewportSize().width;
    const center = (sheetBox?.x ?? 0) + (sheetBox?.width ?? 0) / 2;
    assert(
      sheetBox != null &&
        sheetBox.x >= -2 &&
        sheetBox.x + sheetBox.width <= vw + 2 &&
        Math.abs(center - vw / 2) < 24,
      `notification sheet is on-screen + centered (x ${Math.round(sheetBox?.x ?? -1)}, w ${Math.round(sheetBox?.width ?? -1)}, vw ${vw})`,
    );
  }
  // Visual evidence of the mobile pull-down sheet shell (flat, full-width,
  // safe-area aware) while it is open.
  await snap(mobile, "mobile-notification-sheet");
  // Close it again (Escape — the sheet's documented dismiss) so the rail swipe
  // below starts from a clean, settled home.
  await mobile.keyboard.press("Escape");
  await mobile
    .getByTestId("notification-sheet-close")
    .waitFor({ state: "detached", timeout: 4000 });
  assert(
    (await mobile.getByTestId("notification-sheet-close").count()) === 0,
    "the notification sheet closes again (Escape)",
  );
  await waitForSurfacePageSettled(mobile, "home");

  // Real touch left-swipe on the home half pages the outer rail to the
  // launcher (the halves are `touch-pan-y`, so a horizontal touch gesture is
  // the rail's — exactly the phone input this profile emulates).
  await touchSwipeLeft(mobile, "home-launcher-home-page");
  await waitForSurfacePageSettled(mobile, "launcher");
  assert(
    (await mobile.getByTestId("rail-pager-edge-prev").count()) === 0 &&
      (await mobile.getByTestId("rail-pager-edge-next").count()) === 0 &&
      (await mobile.getByTestId("launcher-pager-edge-prev").count()) === 0 &&
      (await mobile.getByTestId("launcher-pager-edge-next").count()) === 0,
    "mobile coarse-pointer: no rail or launcher edge buttons on launcher",
  );

  // ── Curated apps page — the everyday apps render as tiles, in curated order.
  for (const id of ["wallet", "automations", "browser", "settings"]) {
    assert(
      await mobile.getByTestId(`launcher-tile-${id}`).isVisible(),
      `curated app "${id}" renders on the launcher apps page`,
    );
  }
  // ── No dock: every view (Chat included) tiles on the page grid. The
  // featured-views dock was removed, so there is no `launcher-dock` element.
  assert(
    (await mobile.getByTestId("launcher-dock").count()) === 0,
    "the launcher renders no dock (featured-views header removed)",
  );
  assert(
    await mobile.getByTestId("launcher-tile-chat").isVisible(),
    "Chat renders as a page tile on the launcher (no dock)",
  );
  // ── Removed / hidden surfaces never tile: removed apps, wallet sub-views,
  // and the deduped duplicate registrations.
  for (const id of ["views", "shopify", "hyperliquid", "inventory", "triggers"]) {
    assert(
      (await mobile.getByTestId(`launcher-tile-${id}`).count()) === 0,
      `"${id}" is absent from the launcher (removed/hidden/deduped)`,
    );
  }
  // A single Wallet tile survives the duplicate wallet + inventory registrations.
  assert(
    (await mobile.getByTestId("launcher-tile-wallet").count()) === 1,
    "duplicate wallet registrations collapse to one tile",
  );

  // ── Real image icons — curated tiles carry hero images, so each renders an
  // <img> tile (not the glyph fallback). On device the agent serves the branded
  // SVG at /api/views/:id/hero, resolved through the runtime API base so it
  // loads on native (file://) shells too.
  for (const id of ["wallet", "automations", "browser", "character"]) {
    const img = mobile.getByTestId(`launcher-image-${id}`);
    assert(
      (await img.count()) === 1 && (await img.isVisible()),
      `curated app "${id}" renders a real image icon (hero <img>, not a glyph)`,
    );
    const src = await img.getAttribute("src");
    assert(
      typeof src === "string" && src.startsWith("data:image/svg+xml"),
      `curated app "${id}" image src is the branded hero (${String(src).slice(0, 24)}…)`,
    );
  }

  await snap(mobile, "mobile-launcher");

  // ── NO page indicator — the dots were removed (they collided with the chat
  // composer). Navigation is swipe-only. Neither the rail indicator nor the
  // inner Launcher dot strip may render.
  assert(
    (await mobile
      .locator('[data-testid="home-launcher-indicator"]')
      .count()) === 0,
    "the page indicator is removed (no colliding dots)",
  );
  assert(
    (await mobile.locator('[aria-label^="Page "]').count()) === 0,
    "the inner Launcher dot strip is absent too",
  );

  // ── Real per-view images — every tile shows a branded hero IMAGE (generated
  // client-side as a data URI when no real hero exists). A deterministic glyph
  // may sit underneath the image as a decode fallback, but no tile may be glyph
  // only. Each view's hero is deterministic per id, so the srcs are distinct.
  const imageSrcs = await mobile.$$eval(
    '[data-testid^="launcher-image-"]',
    (imgs) =>
      Array.from(
        new Set(imgs.map((i) => i.getAttribute("src") ?? "")),
      ).filter(Boolean),
  );
  assert(
    imageSrcs.length >= 5,
    `launcher tiles render varied hero images, not one placeholder (${imageSrcs.length} distinct)`,
  );
  assert(
    imageSrcs.every(
      (s) => s.startsWith("data:image/") || /^(https?:|\/api\/)/.test(s),
    ),
    "every tile renders a real hero image (data-URI / served), not a glyph",
  );
  const visualCount = await mobile.locator("[data-view-visual]").count();
  const imageCount = await mobile
    .locator('[data-view-visual] [data-testid^="launcher-image-"]')
    .count();
  assert(
    imageCount === visualCount,
    `no tile falls back to a bare glyph-only visual (${imageCount}/${visualCount} have images)`,
  );

  // ── The curated launcher is READ-ONLY: a long-press never enters edit mode
  // (fixed placement, no reorder). Edit mode animates tiles with `animate-pulse`,
  // so its absence after a stationary hold is the real read-only signal. #3
  await longPressHold(mobile, "launcher-tile-wallet");
  await mobile.waitForTimeout(150);
  assert(
    (await mobile
      .getByTestId("launcher-tile-wallet")
      .locator("button.animate-pulse")
      .count()) === 0,
    "a stationary long-press does NOT enter edit mode (curated launcher is read-only)",
  );
  // A REAL touch right-swipe still returns HOME cleanly (at the launcher's
  // first page the boundary right-swipe belongs to the outer rail).
  await touchSwipeRight(mobile, "home-launcher-launcher-page");
  await waitForSurfacePageSettled(mobile, "home");
  assert(
    (await mobile
      .getByTestId("home-launcher-surface")
      .getAttribute("data-page")) === "home",
    "swipe-back from the launcher returns HOME",
  );
  await touchSwipeLeft(mobile, "home-launcher-home-page");
  await waitForSurfacePageSettled(mobile, "launcher");

  // ── Rail-swipe FPS gate: sample REAL frames over three full home↔launcher
  // round-trips (right swipe back home, left swipe to the launcher — the exact
  // gesture the launcher redesign must keep smooth) and hard-fail on sustained
  // jank via the same shared, meta-tested frame-budget detectors the chat perf
  // gates use. The rail paints via rAF-paced translate3d, so a regression that
  // moves work onto the drag path (layout, paint storms, main-thread stalls)
  // shows up here as dropped frames / p95 blowout.
  {
    await mobile.evaluate(() => window.__ELIZA_FRAME.start());
    for (let i = 0; i < 3; i += 1) {
      await touchSwipeRight(mobile, "home-launcher-launcher-page");
      await waitForSurfacePageSettled(mobile, "home");
      await touchSwipeLeft(mobile, "home-launcher-home-page");
      await waitForSurfacePageSettled(mobile, "launcher");
    }
    const { deltas, longTasks } = await mobile.evaluate(() =>
      window.__ELIZA_FRAME.read(),
    );
    await mobile.evaluate(() => window.__ELIZA_FRAME.stop());
    const s = summarizeFrameSamples(deltas, longTasks, FRAME_BUDGET);
    const droppedPct = (100 * s.droppedFrames) / Math.max(1, s.sampleCount);
    console.log(
      `  [rail-swipe] fps=${s.fps.toFixed(1)} p95=${s.p95FrameMs.toFixed(1)}ms ` +
        `worst=${s.worstFrameMs.toFixed(1)}ms dropped=${s.droppedFrames}/${s.sampleCount} ` +
        `(${droppedPct.toFixed(0)}%) long=${s.longTasks}`,
    );
    assert(
      s.sampleCount >= MIN_FRAME_SAMPLES,
      `rail-swipe window captured ≥${MIN_FRAME_SAMPLES} frames (got ${s.sampleCount})`,
    );
    assert(
      !shouldReportFrameBudget(s, FRAME_GATE),
      `rail swipe stays within the frame budget (p95 ${s.p95FrameMs.toFixed(1)}ms ≤ ` +
        `${(s.budgetMs * FRAME_GATE.p95BudgetFactor).toFixed(1)}ms, dropped ` +
        `${droppedPct.toFixed(0)}% < ${(FRAME_GATE.droppedFrameRatio * 100).toFixed(0)}%)`,
    );
  }

  // ── ONE page of views. Developer tools are NOT a separate swipeable page any
  // more: when Developer Mode is on they sit on the SAME single page after the
  // apps (this fixture enables developer mode, so they render). There is no
  // page 2 and no inter-page view paging to swipe to.
  for (const id of [
    "trajectories",
    "database",
    "runtime",
    "logs",
    "skills",
    "plugins",
  ]) {
    assert(
      (await mobile
        .getByTestId("launcher-page-0")
        .getByTestId(`launcher-tile-${id}`)
        .count()) === 1,
      `developer tool "${id}" renders on the single launcher page (page 0)`,
    );
  }
  assert(
    (await mobile.getByTestId("launcher-page-1").count()) === 0,
    "there is no second launcher page (single curated page of views)",
  );
  // A left-swipe on the single-page launcher has nowhere to go — it rubber-bands
  // and never advances to a nonexistent page, staying on the launcher.
  await touchSwipeLeft(mobile, "launcher-page-window");
  await mobile.waitForTimeout(500);
  assert(
    (await mobile
      .getByTestId("home-launcher-surface")
      .getAttribute("data-page")) === "launcher" &&
      (await mobile.getByTestId("launcher-page-1").count()) === 0,
    "a left-swipe on the single page rubber-bands (no page 2, stays on launcher)",
  );
  await snap(mobile, "mobile-launcher-single-page");

  // The home is a clean, action-driven dashboard: no Edit chrome, no "Pinned"
  // label (edit-dashboard is an agent action, not a button).
  assert(
    (await mobile.getByTestId("home-edit-toggle").count()) === 0,
    "no Edit toggle (clean dashboard)",
  );
  assert(
    (await mobile.getByText("Pinned", { exact: true }).count()) === 0,
    'no "Pinned" label',
  );
  const mobileVideo = await mobile.video();
  await mobile.close();
  await mobileContext.close();
  if (mobileVideo) {
    const videoPath = await mobileVideo.path();
    const stableVideoPath = join(outDir, RECORDED_VIDEO_FILE);
    await rename(videoPath, stableVideoPath);
    console.log(`  🎥 ${stableVideoPath}`);
  }

  // Desktop width
  const desktop = await browser.newPage({
    viewport: { width: 1180, height: 900 },
  });
  desktop.on("pageerror", (e) => sink.errors.push(String(e)));
  await desktop.goto(url);
  await desktop.waitForSelector('[data-testid="home-launcher-surface"]');
  await desktop.waitForSelector('[data-testid="home-screen"]');
  await desktop.waitForTimeout(500);
  // Off-AOSP: no pinned tiles at all — the tile grid is omitted entirely.
  assert(
    (await desktop.getByTestId("home-tiles").count()) === 0,
    "no pinned tiles off-AOSP (grid omitted)",
  );
  assert(
    (await desktop.getByTestId("home-tile-phone").count()) === 0,
    "phone tile hidden when native disabled",
  );
  await snap(desktop, "desktop-home");
  await swipeLeft(desktop.getByTestId("home-launcher-home-page"));
  await waitForSurfacePageSettled(desktop, "launcher");
  await snap(desktop, "desktop-launcher");
  await desktop.close();

  // #10717: the web/desktop `< >` edge buttons render ONLY on fine-pointer /
  // hover-capable devices. The mobile path above explicitly emulates touch /
  // coarse-pointer and asserts the buttons are absent; this page forces the
  // fine-pointer media features before load to exercise + capture them.
  const finePointer = await browser.newPage({
    viewport: { width: 1180, height: 900 },
  });
  finePointer.on("pageerror", (e) => sink.errors.push(String(e)));
  await finePointer.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    const stub = (query) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    });
    window.matchMedia = (query) =>
      /hover: hover|pointer: fine/.test(query) ? stub(query) : real(query);
  });
  await finePointer.goto(url);
  await finePointer.waitForSelector('[data-testid="home-launcher-surface"]');
  await finePointer.waitForTimeout(400);
  // On the HOME half the rail offers a `>` (→ launcher) and no `<` (home is the
  // first view).
  assert(
    (await finePointer.getByTestId("rail-pager-edge-next").count()) === 1,
    "desktop fine-pointer: `>` edge button present on home",
  );
  assert(
    (await finePointer.getByTestId("rail-pager-edge-prev").count()) === 0,
    "desktop fine-pointer: no `<` edge button on the first (home) view",
  );
  await snap(finePointer, "desktop-edge-buttons-home");
  // Click `>` to page to the launcher; the `<` (→ home) now appears.
  await finePointer.getByTestId("rail-pager-edge-next").click();
  await waitForSurfacePageSettled(finePointer, "launcher");
  assert(
    (await finePointer.getByTestId("rail-pager-edge-prev").count()) === 1,
    "desktop fine-pointer: `<` edge button (→ home) present on the launcher",
  );
  await snap(finePointer, "desktop-edge-buttons-launcher");

  // Desktop notification PANEL (#10706 / per-surface shells): page back to home
  // and open the home notification affordance. On a fine-pointer wide surface
  // HomeScreen's `variant="auto"` NotificationCenter must render the top-RIGHT
  // anchored PANEL — not the mobile pull-down sheet. Assert the shell + its
  // right anchoring, capture it, then dismiss via the transparent backdrop.
  await finePointer.getByTestId("rail-pager-edge-prev").click();
  await waitForSurfacePageSettled(finePointer, "home");
  await finePointer.getByTestId("home-notification-pull-zone").click();
  await finePointer
    .getByTestId("notification-panel")
    .waitFor({ state: "visible", timeout: 4000 });
  assert(
    (await finePointer.getByTestId("notification-panel").count()) === 1 &&
      (await finePointer.getByTestId("notification-sheet").count()) === 0,
    "desktop fine-pointer opens the PANEL shell (not the mobile sheet)",
  );
  {
    const panelBox = await finePointer
      .getByTestId("notification-panel")
      .boundingBox();
    const vw = finePointer.viewportSize().width;
    const rightEdge = (panelBox?.x ?? 0) + (panelBox?.width ?? 0);
    // Right-anchored AND on-screen: the panel's right edge hugs the viewport's
    // right edge WITHOUT overshooting it. (A `position: fixed` panel trapped in
    // the transformed home↔launcher rail would anchor to the 2×-wide rail and
    // land at ~2×vw — off-screen right; this catches that regression.)
    assert(
      panelBox != null && rightEdge > vw - 40 && rightEdge <= vw + 2,
      `desktop notification panel is right-anchored on-screen (right edge ${Math.round(rightEdge)}, vw ${vw})`,
    );
  }
  await snap(finePointer, "desktop-notification-panel");
  await finePointer.getByTestId("notification-panel-backdrop").click();
  await finePointer
    .getByTestId("notification-panel")
    .waitFor({ state: "detached", timeout: 4000 });
  assert(
    (await finePointer.getByTestId("notification-panel").count()) === 0,
    "desktop notification panel dismisses on outside click (backdrop)",
  );

  await finePointer.close();
} finally {
  await browser.close();
}

assert(sink.errors.length === 0, `no page errors (${sink.errors.length})`);
for (const e of sink.errors) console.error(`  ⚠ ${e}`);

console.log(`\nScreenshots (${shot}) → ${outDir}`);
if (failures > 0) {
  console.error(`\nHOME-SCREEN E2E FAILED (${failures})`);
  process.exit(1);
}
console.log("\nHOME-SCREEN E2E PASSED");
