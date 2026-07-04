/**
 * Real-browser screenshot e2e for the iOS-style HomeScreen — no app server.
 * Bundles home-screen-fixture.tsx with esbuild (stubbing the data sources), loads
 * it in headless chromium, and asserts the Home/Launcher consolidation +
 * captures mobile + desktop screenshots plus a mobile interaction recording.
 *
 * Run: bun run --cwd packages/ui test:home-screen-e2e
 */

import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  createAssertGate,
  createSnapper,
  finishRun,
  stubNodeBuiltins,
  writeFixturePage,
} from "../../../testing/e2e-runner/index.ts";
import {
  FRAME_SAMPLER_INIT,
  summarizeFrameSamples,
} from "../../../hooks/frame-budget.ts";
import {
  LAYOUT_SHIFT_OBSERVER_INIT,
  summarizeStability,
} from "../../../testing/layout-stability.ts";
import {
  touchDragHold,
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
const DROPPED_FRAME_EPSILON_MS = 0.5;
const MIN_FRAME_SAMPLES = 30;
const RAIL_SWIPE_ATTEMPTS = 3;
const RAIL_SWIPE_CYCLES_PER_ATTEMPT = 3;

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

await clearGeneratedVideoArtifacts();

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
// the mocked window.fetch + the stubbed client). The shared stubNodeBuiltins
// no-op-proxies every node builtin so the browser bundle builds; if any of it
// actually ran at module load the page-error guard below would catch it.

// The real app's viewport meta + the shell's runtime CSS vars: without the meta,
// a mobile page falls back to the 980px layout viewport, so CSS `vw` units (the
// sheet's `w-[min(440px,100vw-1rem)]`) mis-measure and the overlay mis-centers.
const headHtml = `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
<style>:root{--eliza-continuous-chat-clearance:5.25rem;--safe-area-bottom:0px;--eliza-mobile-nav-offset:0px}</style>`;
const url = await writeFixturePage({
  entry: join(here, "home-screen-fixture.tsx"),
  outDir,
  htmlName: "home-screen.html",
  title: "home screen e2e",
  plugins: [stubResolver, stubElizaCore, stubNodeBuiltins()],
  processShim: true,
  headHtml,
  background: "#0a0d16",
});

const sink = { errors: [] };
const browser = await chromium.launch();
const gate = createAssertGate();
const { assert } = gate;
const snap = createSnapper({ outDir });
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
function medianNumber(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
async function measureRailSwipeWindow(page) {
  await page.evaluate(() => window.__ELIZA_FRAME.start());
  try {
    for (let i = 0; i < RAIL_SWIPE_CYCLES_PER_ATTEMPT; i += 1) {
      await touchSwipeRight(page, "home-launcher-launcher-page");
      await waitForSurfacePageSettled(page, "home");
      await touchSwipeLeft(page, "home-launcher-home-page");
      await waitForSurfacePageSettled(page, "launcher");
    }
    const { deltas, longTasks } = await page.evaluate(() =>
      window.__ELIZA_FRAME.read(),
    );
    const summary = summarizeFrameSamples(deltas, longTasks, FRAME_BUDGET);
    // Chromium's headless rAF timestamps commonly quantize 60 Hz frames as
    // 16.7-16.8ms. Treat those as on-budget; real drops still exceed the budget
    // by more than the timestamp jitter and p95 remains the primary jank gate.
    const effectiveDroppedFrames = deltas.filter(
      (delta) =>
        Number.isFinite(delta) &&
        delta > summary.budgetMs + DROPPED_FRAME_EPSILON_MS,
    ).length;
    const droppedFrameRatio =
      effectiveDroppedFrames / Math.max(1, summary.sampleCount);
    const droppedPct = 100 * droppedFrameRatio;
    return {
      ...summary,
      effectiveDroppedFrames,
      droppedFrameRatio,
      droppedPct,
    };
  } finally {
    await page.evaluate(() => window.__ELIZA_FRAME.stop());
  }
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

  // The resting notification "pill"/grabber is gone — the redesign removed the
  // always-visible top indicator (and the pull "tag"); pulling down from
  // anywhere brings the real sheet down.
  assert(
    (await mobile.getByTestId("home-notification-grabber").count()) === 0 &&
      (await mobile.getByTestId("home-notification-reveal").count()) === 0,
    "no resting pill/grabber and no pull-tag affordance (removed)",
  );

  const OPEN_SHEET = '[data-testid="notification-sheet"][data-open]';

  // Mid-pull evidence: hold a partial downward drag from the dashboard body. The
  // REAL sheet itself fades in and tracks the finger (it is mounted but NOT yet
  // "open"), so this is what the user sees being pulled down. Screenshot it, then
  // CANCEL — a short/cancelled pull must retract, leaving nothing open.
  {
    const drag = await touchDragHold(
      mobile,
      '[data-testid="home-screen"]',
      0,
      80,
      { steps: 8, stepDelayMs: 12 },
    );
    await mobile.waitForTimeout(90);
    assert(
      (await mobile.getByTestId("notification-sheet").count()) === 1 &&
        (await mobile.locator(OPEN_SHEET).count()) === 0,
      "a partial pull reveals the real sheet, tracking the finger (not yet open)",
    );
    await snap(mobile, "mobile-notification-pull-reveal");
    await drag.cancel();
    await mobile.waitForTimeout(420);
    assert(
      (await mobile.getByTestId("notification-sheet").count()) === 0,
      "a CANCELLED pull retracts the sheet (nothing left open)",
    );
  }

  // iOS-style pull-down from ANYWHERE on the dashboard body fades in + pulls down
  // the NotificationCenter sheet and settles it OPEN — a real touch drag over the
  // widget list (scrolled to the top), not a thin top strip. This is the headline
  // of the redesign, driven through the same CDP touch path as the rail swipes.
  assert(
    (await mobile.getByTestId("notification-sheet").count()) === 0,
    "notification sheet starts closed",
  );
  await touchSwipeDown(mobile, "home-screen");
  await mobile.locator(OPEN_SHEET).waitFor({ state: "visible", timeout: 4000 });
  assert(
    (await mobile.locator(OPEN_SHEET).count()) === 1,
    "real-touch pull-down from the dashboard body opens the notification sheet",
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
  // Visual evidence of the open glass sheet — let the settle finish first so the
  // capture is the resting sheet, not a mid-animation frame.
  await mobile.waitForTimeout(450);
  await snap(mobile, "mobile-notification-sheet");
  // Close it again (Escape — a documented dismiss) so the rail swipe below starts
  // from a clean, settled home.
  await mobile.keyboard.press("Escape");
  await mobile
    .getByTestId("notification-sheet")
    .waitFor({ state: "detached", timeout: 4000 });
  assert(
    (await mobile.getByTestId("notification-sheet").count()) === 0,
    "the notification sheet closes again (Escape)",
  );

  // The top-edge band (the iOS-natural place to start a pull, and the click /
  // keyboard entry point) still opens the sheet via a pull too.
  await touchSwipeDown(mobile, "home-notification-pull-zone");
  await mobile.locator(OPEN_SHEET).waitFor({ state: "visible", timeout: 4000 });
  assert(
    (await mobile.locator(OPEN_SHEET).count()) === 1,
    "a pull from the top-edge band also opens the notification sheet",
  );
  await mobile.keyboard.press("Escape");
  await mobile
    .getByTestId("notification-sheet")
    .waitFor({ state: "detached", timeout: 4000 });
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

  // ── Rail-swipe FPS gate: sample independent windows of REAL frames, each
  // covering three full home↔launcher round-trips (right swipe back home, left
  // swipe to the launcher — the exact gesture the launcher redesign must keep
  // smooth), and hard-fail on sustained jank via the same shared, meta-tested
  // frame-budget detectors the chat perf gates use. The rail paints via
  // rAF-paced translate3d, so a regression that moves work onto the drag path
  // (layout, paint storms, main-thread stalls) shows up here as dropped frames /
  // p95 blowout.
  {
    const attempts = [];
    for (let attempt = 0; attempt < RAIL_SWIPE_ATTEMPTS; attempt += 1) {
      const result = await measureRailSwipeWindow(mobile);
      attempts.push(result);
      console.log(
        `  [rail-swipe ${attempt + 1}/${RAIL_SWIPE_ATTEMPTS}] ` +
          `fps=${result.fps.toFixed(1)} p95=${result.p95FrameMs.toFixed(1)}ms ` +
          `worst=${result.worstFrameMs.toFixed(1)}ms ` +
          `dropped=${result.effectiveDroppedFrames}/${result.sampleCount} ` +
          `(${result.droppedPct.toFixed(0)}%) long=${result.longTasks}`,
      );
      assert(
        result.sampleCount >= MIN_FRAME_SAMPLES,
        `rail-swipe window ${attempt + 1} captured ≥${MIN_FRAME_SAMPLES} frames ` +
          `(got ${result.sampleCount})`,
      );
    }
    const budgetMs = attempts[0]?.budgetMs ?? 1000 / FRAME_BUDGET.targetFps;
    const medianP95FrameMs = medianNumber(
      attempts.map((attempt) => attempt.p95FrameMs),
    );
    const medianDroppedFrameRatio = medianNumber(
      attempts.map((attempt) => attempt.droppedFrameRatio),
    );
    const medianDroppedPct = 100 * medianDroppedFrameRatio;
    const overP95Budget =
      medianP95FrameMs > budgetMs * FRAME_GATE.p95BudgetFactor;
    const overDroppedBudget =
      medianDroppedFrameRatio >= FRAME_GATE.droppedFrameRatio;
    console.log(
      `  [rail-swipe median] p95=${medianP95FrameMs.toFixed(1)}ms ` +
        `dropped=${medianDroppedPct.toFixed(0)}% attempts=${attempts.length}`,
    );
    assert(
      !overP95Budget && !overDroppedBudget,
      `rail swipe median stays within the frame budget (p95 ${medianP95FrameMs.toFixed(1)}ms ≤ ` +
        `${(budgetMs * FRAME_GATE.p95BudgetFactor).toFixed(1)}ms, dropped ` +
        `${medianDroppedPct.toFixed(0)}% < ${(FRAME_GATE.droppedFrameRatio * 100).toFixed(0)}%)`,
    );
  }

  // ── ONE page of views. Developer tools are NOT a separate swipeable page any
  // more: when Developer Mode is on they sit on the SAME single page after the
  // apps (this fixture enables developer mode, so they render). The launcher is
  // one scrolling page window — there is no inter-page view paging to swipe to.
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
        .getByTestId("launcher-page-window")
        .getByTestId(`launcher-tile-${id}`)
        .count()) === 1,
      `developer tool "${id}" renders on the single launcher page`,
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
  // Let the fade-in settle before capturing the glass panel.
  await finePointer.waitForTimeout(300);
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

console.log(`\nScreenshots → ${outDir}`);
finishRun({
  failures: gate.failures,
  passMessage: "\nHOME-SCREEN E2E PASSED",
  failMessage: `\nHOME-SCREEN E2E FAILED (${gate.failures})`,
});
