/**
 * Real-browser screenshot e2e for the iOS-style HomeScreen - no app server.
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
  touchTap,
} from "../../../testing/real-touch-gestures.ts";
import {
  SWIPE_HINT_DISPLAY_MS,
  SWIPE_HINT_FADE_MS,
  SWIPE_HINT_SHOW_DELAY_MS,
  SWIPE_HINT_WIDGET_KEY,
} from "../FirstSessionSwipeHint.tsx";

// Frame gate for the home↔launcher rail swipe - same factor-based thresholds as
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

async function clearGeneratedArtifacts() {
  await rm(join(outDir, RECORDED_VIDEO_FILE), { force: true });
  for (const entry of await readdir(outDir)) {
    if (/^page@.+\.webm$/.test(entry)) {
      await rm(join(outDir, entry), { force: true });
    }
    if (/^\d+-.*\.png$/.test(entry)) {
      await rm(join(outDir, entry), { force: true });
    }
  }
}

await clearGeneratedArtifacts();

// Redirect the live data sources to deterministic stubs.
const stubResolver = {
  name: "home-stub-resolver",
  setup(b) {
    // HomeScreen mounts the REAL unified home-slot WidgetHost (#9143). It resolves
    // its per-plugin widgets from the app-store plugins snapshot and renders them
    // with injected data (seeded in home-screen-fixture.tsx). The data sources -
    // the `client` (base URL + notification methods) and `window.fetch` (lifeops
    // routes) - are stubbed below / in the fixture; the WidgetHost + widget
    // components themselves are NOT stubbed.
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
// implementations. These must be OWN enumerable keys of the exported object -
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
            // The attention-mode home notification center (NotificationsHomeCenter)
            // triages each seeded notification by tier, so it needs the REAL
            // priority→tier mapping — a noop reads back "undefined" through
            // esbuild's own-key __toESM interop and crashes the whole tree
            // ("tierForPriority is not a function"). Mirror core's notification.ts.
            tierForPriority: (priority) =>
              priority === "urgent" || priority === "high"
                ? "interrupt"
                : priority === "low"
                  ? "silent"
                  : "digest",
          },
          { get: (t, p) => (p in t ? t[p] : noop) },
        );
      `,
      loader: "js",
    }));
  },
};

// The REAL WidgetHost subtree transitively reaches server-only code (the hooks
// barrel pulls @elizaos/logger / @elizaos/shared, which import node builtins) -
// DEAD in the browser (never executed at render; the home widgets fetch through
// the mocked window.fetch + the stubbed client). The shared stubNodeBuiltins
// no-op-proxies every node builtin so the browser bundle builds; if any of it
// actually ran at module load the page-error guard below would catch it.

// The real app's viewport meta + the shell's runtime CSS vars: without the meta,
// a mobile page falls back to the 980px layout viewport, so CSS `vw` units (the
// sheet's `w-[min(440px,100vw-1rem)]`) mis-measure and the overlay mis-centers.
// The brand palette vars (`styles/base.css` :root) are seeded here too: the
// calendar up-next card colors its text through `var(--brand-white)` /
// `color-mix(..., var(--brand-white))`, and an undefined var resolves to black —
// unreadable on the dark ember field, tripping the foreground-contrast gate. The
// fixture loads no app CSS, so the handful of brand vars the home widgets read
// must be declared inline. The standalone esbuild page also bypasses Tailwind's
// `@utility` transform; mirror the production scroll-fade mask so Chromium can
// exercise its release handoff instead of treating the class as unstyled.
const headHtml = `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
<style>
:root{--eliza-continuous-chat-clearance:5.25rem;--safe-area-bottom:0px;--eliza-mobile-nav-offset:0px;--brand-white:#fdfaf7;--brand-black:#000000;--brand-orange:#ff6a1f}
.scroll-fade{
  mask-image:linear-gradient(to bottom,transparent 0,#000 1.25rem,#000 calc(100% - 1.5rem),transparent 100%);
  -webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 1.25rem,#000 calc(100% - 1.5rem),transparent 100%);
}
</style>`;
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
// touch input path. These keep the mobile pagers honest - the inner launcher
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

// A STATIONARY hold past the long-press window. On the curated launcher this
// must NOT enter edit mode (the launcher is read-only, fixed placement).
async function longPressHold(page, tileTestId) {
  await touchLongPress(page, `[data-testid="${tileTestId}"] button`, 600);
}

async function installCoarsePointerMedia(page) {
  await page.addInitScript(() => {
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
}

async function readHomeDarkForegrounds(page) {
  return page.evaluate(() => {
    const parseRgb = (value) => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const [r, g, b] = match[1]
        .split(",")
        .slice(0, 3)
        .map((part) => Number.parseFloat(part.trim()));
      return [r, g, b].every(Number.isFinite) ? { r, g, b } : null;
    };
    const channel = (value) => {
      const normalized = value / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ({ r, g, b }) =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    // Home resident set after the spec §E cut: notifications, the merged Today
    // card (with its flagged at-risk goal row), and calendar. wallet.balance +
    // health.sleep left home; goals.attention folded into Today.
    const surfaces = [
      "home-notification-center",
      "chat-widget-todos",
      "todo-goal-attention-row",
      "chat-widget-calendar-upcoming",
    ];
    const failures = [];
    for (const testId of surfaces) {
      const root = document.querySelector(`[data-testid="${testId}"]`);
      if (!(root instanceof HTMLElement)) continue;
      const nodes = [root, ...root.querySelectorAll("*")];
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        const text = node.innerText?.replace(/\s+/g, " ").trim();
        if (!text) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const rgb = parseRgb(getComputedStyle(node).color);
        if (!rgb) continue;
        const lightness = luminance(rgb);
        if (lightness < 0.45) {
          failures.push({
            surface: testId,
            text: text.slice(0, 80),
            color: getComputedStyle(node).color,
            luminance: Number(lightness.toFixed(3)),
          });
        }
      }
    }
    return failures;
  });
}
const ATTENTION_HOME_TEST_IDS = [
  "home-notification-center",
  "chat-widget-needs-attention",
  "chat-widget-todos",
  "todo-goal-attention-row",
  "chat-widget-calendar-upcoming",
];
async function waitForHomeEnterSettled(page) {
  await page.waitForFunction(
    () => {
      const home = document.querySelector('[data-testid="home-screen"]');
      if (!home) return false;
      return !home
        .getAnimations({ subtree: true })
        .some(
          (a) =>
            a.animationName === "home-enter" && a.playState !== "finished",
        );
    },
    undefined,
    { timeout: 5000 },
  );
}
async function assertQuietHome(page, label) {
  await page.waitForSelector('[data-testid="home-screen"]');
  await page.waitForSelector('[data-testid="widget-host-home"]', {
    state: "attached",
  });
  await waitForHomeEnterSettled(page);
  await page.waitForFunction(
    (attentionIds) => {
      const host = document.querySelector('[data-testid="widget-host-home"]');
      if (!(host instanceof HTMLElement)) return false;
      if (host.childElementCount !== 0) return false;
      return attentionIds.every(
        (testId) => document.querySelector(`[data-testid="${testId}"]`) == null,
      );
    },
    ATTENTION_HOME_TEST_IDS,
    { timeout: 15000 },
  );
  assert(
    (await page.getByTestId("home-time-widget").count()) === 1,
    `${label}: time widget remains visible`,
  );
  assert(
    (await page.getByTestId("home-weather").count()) === 1,
    `${label}: weather widget remains visible`,
  );
  assert(
    (await page.getByTestId("widget-host-home").locator(":scope > *").count()) ===
      0,
    `${label}: no ranked attention cards render healthy-empty chrome`,
  );
  for (const testId of ATTENTION_HOME_TEST_IDS) {
    assert(
      (await page.getByTestId(testId).count()) === 0,
      `${label}: ${testId} self-hides when data is healthy-empty`,
    );
  }
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
    const transitionsDone = !rail
      .getAnimations()
      .some((animation) => animation.playState === "running");
    return railSettled && transitionsDone;
  }, pageName);
}
async function waitForRenderedHomeSettled(page) {
  const viewportWidth = page.viewportSize()?.width;
  assert(viewportWidth, "mobile viewport width is available");
  await page.waitForFunction(
    async (expectedViewportWidth) => {
      const sample = () => {
        const surface = document.querySelector(
          '[data-testid="home-launcher-surface"]',
        );
        const rail = document.querySelector(
          '[data-testid="home-launcher-rail"]',
        );
        const home = document.querySelector(
          '[data-testid="home-launcher-home-page"]',
        );
        if (
          !(surface instanceof HTMLElement) ||
          !(rail instanceof HTMLElement) ||
          !(home instanceof HTMLElement)
        ) {
          return null;
        }
        const railRect = rail.getBoundingClientRect();
        const homeRect = home.getBoundingClientRect();
        return {
          railLeft: railRect.left,
          homeLeft: homeRect.left,
          homeRight: homeRect.right,
          viewportWidth: window.innerWidth,
        };
      };
      const first = sample();
      if (!first) return false;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      const second = sample();
      if (!second) return false;
      const stable = ["railLeft", "homeLeft", "homeRight"].every(
        (key) => Math.abs(first[key] - second[key]) < 0.5,
      );
      return (
        stable &&
        Math.abs(second.viewportWidth - expectedViewportWidth) < 1 &&
        Math.abs(second.railLeft) < 1 &&
        Math.abs(second.homeLeft) < 1 &&
        Math.abs(second.homeRight - expectedViewportWidth) < 1
      );
    },
    viewportWidth,
    { timeout: 15000 },
  );
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
  // Mobile (Pixel-ish) - the primary target.
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
  await installCoarsePointerMedia(mobile);
  // Install the shared layout-shift PerformanceObserver BEFORE any paint, so
  // every shift during the home settle lands in window.__ELIZA_LAYOUT_SHIFTS__
  // (the same contract HomeScreen's dev observer + the KPI specs use). We read
  // it after the entrance animation finishes and assert the home doesn't jump
  // (CLS budget + no flicker flash) via the meta-tested summarizeStability.
  await mobile.addInitScript(LAYOUT_SHIFT_OBSERVER_INIT);
  // Frame sampler for the rail-swipe FPS gate below (start()/read()/stop()).
  await mobile.addInitScript(FRAME_SAMPLER_INIT);
  await mobile.goto(`${url}?homeData=quiet`);
  await assertQuietHome(mobile, "quiet account");
  await snap(mobile, "mobile-home-quiet");
  // The preceding quiet-state capture must not consume the one-time lesson;
  // isolate this certification from runner timing before loading its subject.
  await mobile.evaluate(() =>
    localStorage.removeItem("eliza:home-dismissed:v1"),
  );
  await mobile.goto(`${url}?native&homeData=attention`);
  await mobile.waitForSelector('[data-testid="home-launcher-surface"]');
  await mobile.waitForSelector('[data-testid="home-screen"]');
  await mobile.waitForTimeout(600);
  const firstSessionSwipeHint = mobile.getByTestId(
    "first-session-swipe-hint",
  );
  await firstSessionSwipeHint.waitFor({
    state: "visible",
    timeout: SWIPE_HINT_SHOW_DELAY_MS + 2_000,
  });
  assert(
    (await firstSessionSwipeHint.getByText("Swipe for apps").count()) === 1,
    "mobile coarse-pointer: first session renders the swipe lesson",
  );
  await snap(mobile, "mobile-first-session-swipe-hint");
  await firstSessionSwipeHint.waitFor({
    state: "hidden",
    timeout: SWIPE_HINT_DISPLAY_MS + SWIPE_HINT_FADE_MS + 2_000,
  });
  const persistedSwipeHintLife = await mobile.evaluate(
    (widgetKey) =>
      JSON.parse(localStorage.getItem("eliza:home-dismissed:v1") ?? "{}")?.[
        widgetKey
      ],
    SWIPE_HINT_WIDGET_KEY,
  );
  assert(
    persistedSwipeHintLife?.seen === 1 &&
      persistedSwipeHintLife?.dismissed === true,
    "mobile coarse-pointer: completed lesson persists its retirement",
  );
  await mobile.reload();
  await mobile.waitForSelector('[data-testid="home-launcher-surface"]');
  await waitForSurfacePageSettled(mobile, "home");
  await waitForHomeEnterSettled(mobile);
  await mobile.waitForTimeout(SWIPE_HINT_SHOW_DELAY_MS + 1_000);
  await Promise.all([
    mobile.getByTestId("home-time-widget").waitFor({ state: "visible" }),
    mobile.getByTestId("home-weather").waitFor({ state: "visible" }),
    mobile.getByText("Buy groceries", { exact: true }).waitFor({
      state: "visible",
    }),
    mobile.getByText("Design review", { exact: true }).waitFor({
      state: "visible",
    }),
  ]);
  await mobile.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  await waitForRenderedHomeSettled(mobile);
  assert(
    (await mobile.getByTestId("home-launcher-surface").getAttribute(
      "data-page",
    )) === "home",
    "mobile coarse-pointer: reload returns to the home half",
  );
  assert(
    (await mobile.getByTestId("first-session-swipe-hint").count()) === 0,
    "mobile coarse-pointer: retired lesson stays absent after reload",
  );
  // Chromium's first screenshot after a mobile reload can race the compositor
  // layer upload even after DOM geometry and animations have settled. Warm the
  // capture path, then require another stable frame before recording evidence.
  await mobile.screenshot();
  await waitForRenderedHomeSettled(mobile);
  await snap(mobile, "mobile-after-swipe-hint-retired");
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
  // The home mounts the REAL unified home-slot WidgetHost (#9143) - the
  // prioritized dynamic-priority home widgets - fed by the injected mock data
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
  await waitForHomeEnterSettled(mobile);
  // Kept per-plugin home widgets render only when their injected data is
  // attention-worthy. Post spec §E cut, the resident set is Today (todos) - with
  // the at-risk goal folded in as one flagged row - plus calendar. The removed
  // autonomous/domain cards AND the demoted wallet/health cards must stay absent
  // even though the fixture still exposes their plugins/routes elsewhere.
  const WIDGET_CARDS = [
    ["chat-widget-todos", "Buy groceries"],
    // The merged at-risk goal renders inside the Today card (§E item 5).
    ["todo-goal-attention-row", "Ship the release"],
    ["chat-widget-calendar-upcoming", "Design review"],
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
  // Demoted (wallet.balance, health.sleep) + previously-removed domain cards
  // must not resurface as home residents. goals.attention no longer stands
  // alone - its data now lives inside the Today card's flagged row above.
  for (const testId of [
    "widget-goals-attention",
    "widget-health-sleep",
    "chat-widget-wallet-prices",
    "chat-widget-finances-alerts",
    "chat-widget-relationships",
    "chat-widget-inbox-unread",
  ]) {
    assert(
      (await homeWidgetHost.getByTestId(testId).count()) === 0,
      `removed/demoted home widget ${testId} stays absent`,
    );
  }
  // No home widget may fall back to the "Widget failed to render" boundary - an
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
  // Notifications render inline on the home column. Rested mode shows the
  // seeded interrupt-tier row; the count control opens the full shade without
  // adding a second sheet or overlay surface.
  {
    const center = mobile.getByTestId("home-notification-center");
    await center.waitFor({ state: "visible", timeout: 5000 });
    assert(
      (await mobile
        .getByTestId("widget-host-home")
        .getByTestId("home-notification-center")
        .count()) === 0,
      "the notification inbox is inline on the home column, outside the ranked WidgetHost",
    );
    assert(
      (await center.getByTestId("notification-row").count()) === 1,
      "the seeded notification renders as a single row",
    );
    assert(
      (await center.getByTestId("notification-group-label").count()) === 0,
      "no group header eyebrows render — grouping is physical only",
    );
    assert(
      (await center.getByText("Payment failed", { exact: false }).count()) > 0,
      "the notification row shows the seeded title",
    );
    const countButton = center.getByTestId("notifications-count-button");
    assert(
      (await countButton.textContent())?.includes("1 Notification"),
      "the rested count control reflects the seeded notification",
    );
    assert(
      (await center.getByTestId("notifications-clear-all").count()) === 0 &&
        (await center.getByTestId("notifications-collapse").count()) === 0,
      "expanded-only controls stay hidden at rest",
    );

    const countSlot = center.getByTestId("notifications-count");
    const restedCountBox = await countSlot.boundingBox();
    if (!restedCountBox) throw new Error("missing notification count bounds");
    const partialPull = await touchDragHold(
      mobile,
      '[data-testid="home-notification-list"]',
      0,
      48,
      { steps: 6, stepDelayMs: 16 },
    );
    await mobile.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve)),
    );
    const heldCountBox = await countSlot.boundingBox();
    if (!heldCountBox) throw new Error("missing pulled count bounds");
    const heldCountTravel = heldCountBox.y - restedCountBox.y;
    assert(
      heldCountTravel > 1 && heldCountTravel < 28,
      `a partial pull moves the count continuously instead of inserting a 40px row (${heldCountTravel.toFixed(2)}px)`,
    );

    await partialPull.release();
    const releaseTrace = await mobile.evaluate(async (restedTop) => {
      const samples = [];
      const startedAt = performance.now();
      // Keep sampling through the gesture's click-suppression window so the
      // next tap is a distinct user action as well as a settled-state check.
      while (performance.now() - startedAt < 560) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const count = document.querySelector(
          '[data-testid="notifications-count"]',
        );
        if (!(count instanceof HTMLElement)) break;
        samples.push(count.getBoundingClientRect().top - restedTop);
      }
      return samples;
    }, restedCountBox.y);
    const releasePeak = Math.max(...releaseTrace);
    const releaseFinal = releaseTrace.at(-1) ?? Number.POSITIVE_INFINITY;
    assert(
      releasePeak <= heldCountTravel + 1.5,
      `a cancelled pull returns without bouncing farther from rest (${releasePeak.toFixed(2)}px peak)`,
    );
    assert(
      Math.abs(releaseFinal) < 0.75,
      `the notification count settles back at rest (${releaseFinal.toFixed(2)}px)`,
    );

    await touchTap(mobile, '[data-testid="notifications-count-button"]');
    await center
      .locator(
        '[data-testid="home-notification-list"][data-shade-mode="expanded"]',
      )
      .waitFor({ state: "visible", timeout: 5000 });
    assert(
      (await center.getByTestId("notifications-clear-all").count()) === 1 &&
        (await center.getByTestId("notifications-collapse").count()) === 1,
      "opening the shade reveals clear and collapse controls",
    );
    await mobile.waitForFunction(() => {
      const footer = document.querySelector(
        '[data-testid="notifications-collapse-footer"]',
      );
      return footer instanceof HTMLElement && !footer.hasAttribute("inert");
    });

    await touchTap(mobile, '[data-testid="notifications-collapse"]');
    await center
      .locator(
        '[data-testid="home-notification-list"][data-shade-mode="rested"]',
      )
      .waitFor({ state: "visible", timeout: 5000 });
    assert(
      (await center.getByTestId("notifications-clear-all").count()) === 0 &&
        (await center.getByTestId("notifications-collapse").count()) === 0,
      "collapse returns the notification center to its rested controls",
    );
  }
  // No general quick-access tiles anymore - Launcher is the adjacent
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
  {
    const darkForegrounds = await readHomeDarkForegrounds(mobile);
    assert(
      darkForegrounds.length === 0,
      `home card foregrounds stay readable on the dark ember field (${JSON.stringify(
        darkForegrounds.slice(0, 5),
      )})`,
    );
  }

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

  await waitForSurfacePageSettled(mobile, "home");

  // Real touch left-swipe on the home half pages the outer rail to the
  // launcher (the halves are `touch-pan-y`, so a horizontal touch gesture is
  // the rail's - exactly the phone input this profile emulates).
  await touchSwipeLeft(mobile, "home-launcher-home-page");
  await waitForSurfacePageSettled(mobile, "launcher");
  assert(
    (await mobile.getByTestId("rail-pager-edge-prev").count()) === 0 &&
      (await mobile.getByTestId("rail-pager-edge-next").count()) === 0 &&
      (await mobile.getByTestId("launcher-pager-edge-prev").count()) === 0 &&
      (await mobile.getByTestId("launcher-pager-edge-next").count()) === 0,
    "mobile coarse-pointer: no rail or launcher edge buttons on launcher",
  );

  // ── Curated apps page - the everyday apps render as tiles, in curated order.
  for (const id of ["wallet", "automations", "browser", "settings"]) {
    assert(
      await mobile.getByTestId(`launcher-tile-${id}`).isVisible(),
      `curated app "${id}" renders on the launcher apps page`,
    );
  }
  // ── No dock: the featured-views dock was removed, so there is no
  // `launcher-dock` element competing with the curated page grid.
  assert(
    (await mobile.getByTestId("launcher-dock").count()) === 0,
    "the launcher renders no dock (featured-views header removed)",
  );
  assert(
    (await mobile.getByTestId("launcher-tile-chat").count()) === 0,
    "Chat is not duplicated as a launcher tile (home rail is the chat surface)",
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

  // ── Glyph-only app icons (#13453 "deslop the launcher grid"): a launcher tile
  // is a deterministic branded gradient plate + centered Lucide glyph, never a
  // generated hero <img> — the hero PNG painted a cartoon over the real glyph
  // (a virus for Settings, a ladybug for Memories: the "icons are slop" report).
  // Each curated tile exposes its `data-view-visual` plate and NO hero image.
  for (const id of ["wallet", "automations", "browser", "character"]) {
    const visual = mobile.locator(`[data-view-visual="${id}"]`);
    assert(
      (await visual.count()) === 1 && (await visual.isVisible()),
      `curated app "${id}" renders its glyph icon plate`,
    );
    assert(
      (await mobile.getByTestId(`launcher-image-${id}`).count()) === 0,
      `curated app "${id}" renders no hero <img> (glyph-only launcher)`,
    );
  }

  await snap(mobile, "mobile-launcher");

  // ── NO page indicator - the dots were removed (they collided with the chat
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

  // ── Every launcher tile is a glyph-only visual (#13453): a `data-view-visual`
  // gradient plate carrying its Lucide glyph, and never a hero <img>. The plate
  // gradients are deterministic per id (id-hashed palette), so distinct tiles
  // get distinct gradients — a launcher of one flat placeholder would be the
  // regression this guards against.
  const visualCount = await mobile.locator("[data-view-visual]").count();
  assert(
    visualCount >= 5,
    `launcher renders multiple glyph tiles (${visualCount})`,
  );
  assert(
    (await mobile.locator('[data-testid^="launcher-image-"]').count()) === 0,
    "no launcher tile renders a hero <img> (glyph-only launcher)",
  );
  const tileGradients = await mobile.$$eval("[data-view-visual]", (els) =>
    Array.from(
      new Set(
        els
          .map((el) => getComputedStyle(el).backgroundImage)
          .filter((v) => Boolean(v) && v !== "none"),
      ),
    ),
  );
  assert(
    tileGradients.length >= 3,
    `launcher glyph plates use varied gradients, not one placeholder (${tileGradients.length} distinct)`,
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

  // ── ONE page of views. Developer tools are NOT a separate swipeable page any
  // more: when Developer Mode is on they sit on the SAME single page after the
  // apps (this fixture enables developer mode, so they render). The launcher is
  // one scrolling page window - there is no inter-page view paging to swipe to.
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
  // A left-swipe on the single-page launcher has nowhere to go - it rubber-bands
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
  await mobile.goto(`${url}?homeData=quiet`);
  await assertQuietHome(mobile, "quiet account after clearing attention data");
  await snap(mobile, "mobile-home-quiet-after-clear");
  const mobileStorageState = await mobileContext.storageState();
  const mobileVideo = await mobile.video();
  await mobile.close();
  await mobileContext.close();
  if (mobileVideo) {
    const videoPath = await mobileVideo.path();
    const stableVideoPath = join(outDir, RECORDED_VIDEO_FILE);
    await rename(videoPath, stableVideoPath);
    console.log(`  🎥 ${stableVideoPath}`);
  }

  // A dedicated three-row quiet stack exercises the transitions that cannot
  // exist in the default urgent-row fixture: click-open insertion, producer
  // fan-out, empty-region collapse/close-race handling, and a cancelled pull
  // settle.
  const notificationMotionContext = await browser.newContext({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  const notificationMotion = await notificationMotionContext.newPage();
  notificationMotion.on("pageerror", (e) => sink.errors.push(String(e)));
  await installCoarsePointerMedia(notificationMotion);
  await notificationMotion.goto(`${url}?notificationMotion`);
  const notificationCenter = notificationMotion.getByTestId(
    "home-notification-center",
  );
  await notificationCenter.waitFor({ state: "visible", timeout: 5000 });
  await waitForHomeEnterSettled(notificationMotion);
  assert(
    (await notificationCenter.getByTestId("notification-row").count()) === 0,
    "quiet notification stack starts folded behind the total",
  );

  await notificationMotion.evaluate(() => {
    window.__ELIZA_NOTIFICATION_OPEN_TRACE__ = [];
    const startedAt = performance.now();
    const sample = () => {
      const group = document.querySelector(
        "[data-notification-group-content]",
      );
      const count = document.querySelector('[data-testid="notifications-count"]');
      const groupLayer = group?.closest("[data-notification-group]");
      const clear = document.querySelector("[data-notification-clear-slot]");
      window.__ELIZA_NOTIFICATION_OPEN_TRACE__.push({
        t: performance.now() - startedAt,
        group: group
          ? {
              opacity: Number.parseFloat(getComputedStyle(group).opacity),
              top: group.getBoundingClientRect().top,
              duration: getComputedStyle(group).transitionDuration,
              zIndex: groupLayer
                ? getComputedStyle(groupLayer).zIndex
                : null,
            }
          : null,
        count: count
          ? {
              opacity: Number.parseFloat(getComputedStyle(count).opacity),
              height: count.getBoundingClientRect().height,
              duration: getComputedStyle(count).transitionDuration,
              zIndex: getComputedStyle(count).zIndex,
            }
          : null,
        clear: clear
          ? {
              opacity: Number.parseFloat(getComputedStyle(clear).opacity),
              height: clear.getBoundingClientRect().height,
              duration: getComputedStyle(clear).transitionDuration,
            }
          : null,
      });
      if (performance.now() - startedAt < 420) requestAnimationFrame(sample);
    };
    const countButton = document.querySelector(
      '[data-testid="notifications-count-button"]',
    );
    if (!(countButton instanceof HTMLButtonElement)) {
      throw new Error("missing notification count button");
    }
    countButton.click();
    requestAnimationFrame(sample);
  });
  await notificationMotion.waitForTimeout(460);
  const openTrace = await notificationMotion.evaluate(
    () => window.__ELIZA_NOTIFICATION_OPEN_TRACE__,
  );
  const mountedOpenFrames = openTrace.filter((sample) => sample.group);
  const openIntermediateOpacity = new Set(
    mountedOpenFrames
      .map((sample) => sample.group.opacity)
      .filter((opacity) => opacity > 0.05 && opacity < 0.95)
      .map((opacity) => opacity.toFixed(2)),
  );
  const openIntermediateCountHeights = new Set(
    mountedOpenFrames
      .map((sample) => sample.count.height)
      .filter((height) => height > 0.75 && height < 31.25)
      .map((height) => height.toFixed(1)),
  );
  const openIntermediateClearHeights = new Set(
    mountedOpenFrames
      .map((sample) => sample.clear.height)
      .filter((height) => height > 0.75 && height < 31.25)
      .map((height) => height.toFixed(1)),
  );
  assert(
    mountedOpenFrames[0]?.group.opacity <= 0.05,
    `click-open mounts at the transition origin (${mountedOpenFrames[0]?.group.opacity ?? "missing"})`,
  );
  console.log(
    `  [notification click-open] distinct intermediate frames=${openIntermediateOpacity.size}`,
  );
  assert(
    openIntermediateOpacity.size >= 2 &&
      openIntermediateCountHeights.size >= 2 &&
      openIntermediateClearHeights.size >= 2,
    `click-open produces intermediate group/count/clear frames (${openIntermediateOpacity.size}/${openIntermediateCountHeights.size}/${openIntermediateClearHeights.size})`,
  );
  assert(
    mountedOpenFrames[0]?.group.duration.includes("0.22s") &&
      mountedOpenFrames[0]?.count.duration.includes("0.22s") &&
      mountedOpenFrames[0]?.clear.duration.includes("0.22s"),
    `click-open uses one 220ms group/count/clear settle (${JSON.stringify(mountedOpenFrames[0] ?? null)})`,
  );
  assert(
    mountedOpenFrames.every(
      (sample) => sample.group.zIndex === "1" && sample.count.zIndex === "0",
    ),
    "click-open keeps notification cards above the fading count label",
  );
  assert(
    mountedOpenFrames.every(
      (sample, index) =>
        index === 0 ||
        sample.group.opacity + 0.02 >=
          mountedOpenFrames[index - 1].group.opacity,
    ),
    "click-open opacity advances monotonically",
  );
  assert(
    mountedOpenFrames.at(-1)?.group.opacity >= 0.98 &&
      mountedOpenFrames.at(-1)?.count.height < 0.75 &&
      mountedOpenFrames.at(-1)?.clear.height > 31,
    "click-open settles with the group visible and count/clear slots exchanged",
  );

  const notificationCenterBox = await notificationCenter.boundingBox();
  const notificationListBox = await notificationCenter
    .getByTestId("home-notification-list")
    .boundingBox();
  if (!notificationCenterBox || !notificationListBox) {
    throw new Error("missing notification motion geometry");
  }
  const emptyLaneX = notificationCenterBox.x + notificationCenterBox.width / 2;
  const emptyLaneStartY =
    notificationCenterBox.y + notificationCenterBox.height - 60;
  assert(
    emptyLaneStartY > notificationListBox.y + notificationListBox.height + 8,
    "mouse collapse starts below the notification list",
  );
  const emptyLaneHitsList = await notificationMotion.evaluate(
    ({ x, y }) => {
      const list = document.querySelector(
        '[data-testid="home-notification-list"]',
      );
      const target = document.elementFromPoint(x, y);
      return Boolean(list && target && list.contains(target));
    },
    { x: emptyLaneX, y: emptyLaneStartY },
  );
  assert(!emptyLaneHitsList, "empty-region drag hit-tests outside the list");

  const emptyTouchLaneSelector =
    '[data-testid="notification-empty-touch-lane"]';
  await notificationMotion.evaluate(
    ({ x, y }) => {
      const center = document.querySelector(
        '[data-testid="home-notification-center"]',
      );
      if (!(center instanceof HTMLElement)) {
        throw new Error("missing notification touch-lane center");
      }
      const bounds = center.getBoundingClientRect();
      const target = document.createElement("div");
      target.dataset.testid = "notification-empty-touch-lane";
      Object.assign(target.style, {
        position: "absolute",
        left: `${x - bounds.left - 12}px`,
        top: `${y - bounds.top - 12}px`,
        width: "24px",
        height: "24px",
        zIndex: "50",
      });
      center.append(target);
    },
    { x: emptyLaneX, y: emptyLaneStartY },
  );

  await notificationMotion.evaluate(() => {
    window.__ELIZA_NOTIFICATION_CLOSE_TRACE__ = [];
    const startedAt = performance.now();
    const sample = () => {
      const list = document.querySelector(
        '[data-testid="home-notification-list"]',
      );
      const count = document.querySelector(
        '[data-testid="notifications-count"]',
      );
      const clear = document.querySelector("[data-notification-clear-slot]");
      const group = document.querySelector(
        "[data-notification-group-content]",
      );
      const groupLayer = group?.closest("[data-notification-group]");
      window.__ELIZA_NOTIFICATION_CLOSE_TRACE__.push({
        t: performance.now() - startedAt,
        mode: list?.getAttribute("data-shade-mode"),
        count: count
          ? {
              top: count.getBoundingClientRect().top,
              height: count.getBoundingClientRect().height,
              opacity: Number.parseFloat(getComputedStyle(count).opacity),
              duration: getComputedStyle(count).transitionDuration,
              zIndex: getComputedStyle(count).zIndex,
            }
          : null,
        clear: clear
          ? {
              height: clear.getBoundingClientRect().height,
              opacity: Number.parseFloat(getComputedStyle(clear).opacity),
              duration: getComputedStyle(clear).transitionDuration,
            }
          : null,
        group: group
          ? {
              opacity: Number.parseFloat(getComputedStyle(group).opacity),
              duration: getComputedStyle(group).transitionDuration,
              zIndex: groupLayer
                ? getComputedStyle(groupLayer).zIndex
                : null,
            }
          : null,
      });
      if (performance.now() - startedAt < 420) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  await notificationCenter.getByTestId("notifications-collapse").click();
  assert(
    (await notificationCenter
      .getByTestId("home-notification-list")
      .getAttribute("data-shade-settling")) !== null,
    "notification shade exposes its committed close settle",
  );
  const closeRaceState = await notificationMotion.evaluate(
    ({ x, y }) => {
      const center = document.querySelector(
        '[data-testid="home-notification-center"]',
      );
      const list = document.querySelector(
        '[data-testid="home-notification-list"]',
      );
      const target = document.elementFromPoint(x, y);
      if (!(center instanceof HTMLElement) || !(target instanceof Element)) {
        throw new Error("missing notification close-race target");
      }
      const dispatchGesture = (pointerId, endY) => {
        target.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            pointerType: "mouse",
            pointerId,
            isPrimary: true,
            buttons: 1,
            clientX: x,
            clientY: y,
          }),
        );
        target.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            cancelable: true,
            pointerType: "mouse",
            pointerId,
            isPrimary: true,
            buttons: 1,
            clientX: x,
            clientY: endY,
          }),
        );
        target.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            pointerType: "mouse",
            pointerId,
            isPrimary: true,
            clientX: x,
            clientY: endY,
          }),
        );
      };
      dispatchGesture(71, y - 30);
      dispatchGesture(72, y - 160);
      return {
        mode: list?.getAttribute("data-shade-mode"),
        settling: list?.hasAttribute("data-shade-settling"),
        dragging: list?.hasAttribute("data-shade-dragging"),
        cancelling: center.hasAttribute(
          "data-notification-shade-cancelling",
        ),
      };
    },
    { x: emptyLaneX, y: emptyLaneStartY },
  );
  assert(
    closeRaceState.mode === "expanded" &&
      closeRaceState.settling &&
      !closeRaceState.dragging &&
      !closeRaceState.cancelling,
    `empty-region swipes cannot interrupt a committed close (${JSON.stringify(closeRaceState)})`,
  );
  await notificationMotion.waitForTimeout(460);
  const closeTrace = await notificationMotion.evaluate(
    () => window.__ELIZA_NOTIFICATION_CLOSE_TRACE__,
  );
  const mountedCloseFrames = closeTrace.filter(
    (sample) => sample.count && sample.clear && sample.group,
  );
  const closeIntermediateCountHeights = new Set(
    closeTrace
      .map((sample) => sample.count?.height)
      .filter((height) => height > 0.75 && height < 31.25)
      .map((height) => height.toFixed(1)),
  );
  const closeIntermediateClearHeights = new Set(
    mountedCloseFrames
      .map((sample) => sample.clear.height)
      .filter((height) => height > 0.75 && height < 31.25)
      .map((height) => height.toFixed(1)),
  );
  const closeIntermediateGroupOpacity = new Set(
    mountedCloseFrames
      .map((sample) => sample.group.opacity)
      .filter((opacity) => opacity > 0.05 && opacity < 0.95)
      .map((opacity) => opacity.toFixed(2)),
  );
  const visibleCloseCountFrames = closeTrace.filter(
    (sample) => sample.count && sample.count.height > 0.75,
  );
  const closeCountTops = visibleCloseCountFrames.map(
    (sample) => sample.count.top,
  );
  const closeMaxUpwardStep = Math.max(
    0,
    ...closeCountTops.slice(1).map((top, index) => closeCountTops[index] - top),
  );
  const closeMaxDownwardStep = Math.max(
    0,
    ...closeCountTops.slice(1).map((top, index) => top - closeCountTops[index]),
  );
  const closeFinalTop = closeCountTops.at(-1) ?? Number.POSITIVE_INFINITY;
  const closeMinTop = Math.min(...closeCountTops);
  console.log(
    `  [notification click-close] intermediate=${closeIntermediateCountHeights.size}/${closeIntermediateClearHeights.size}/${closeIntermediateGroupOpacity.size} max-up=${closeMaxUpwardStep.toFixed(2)}px max-down=${closeMaxDownwardStep.toFixed(2)}px`,
  );
  assert(
    closeIntermediateCountHeights.size >= 2 &&
      closeIntermediateClearHeights.size >= 2 &&
      closeIntermediateGroupOpacity.size >= 2,
    `click-close produces intermediate count/clear/group frames (${closeIntermediateCountHeights.size}/${closeIntermediateClearHeights.size}/${closeIntermediateGroupOpacity.size})`,
  );
  assert(
    mountedCloseFrames[0]?.count.duration.includes("0.22s") &&
      mountedCloseFrames[0]?.clear.duration.includes("0.22s") &&
      mountedCloseFrames[0]?.group.duration.includes("0.22s"),
    `click-close uses one 220ms count/clear/group settle (${JSON.stringify(mountedCloseFrames[0] ?? null)})`,
  );
  assert(
    mountedCloseFrames.every(
      (sample) => sample.group.zIndex === "1" && sample.count.zIndex === "0",
    ),
    "click-close keeps notification cards above the fading count label",
  );
  assert(
    closeMaxUpwardStep < 12 &&
      closeMaxDownwardStep < 1.5 &&
      closeFinalTop - closeMinTop < 1,
    `notification count reaches its rested top monotonically without a jump or bounce (${JSON.stringify({ closeMaxUpwardStep, closeMaxDownwardStep, closeFinalTop, closeMinTop })})`,
  );
  assert(
    (await notificationCenter
      .getByTestId("home-notification-list")
      .getAttribute("data-shade-mode")) === "rested",
    "the original close clock completes after rejected empty-region swipes",
  );

  await notificationCenter.getByTestId("notifications-count-button").click();
  await notificationMotion.waitForTimeout(300);

  await notificationMotion.mouse.move(emptyLaneX, emptyLaneStartY);
  await notificationMotion.mouse.down();
  await notificationMotion.mouse.move(emptyLaneX, emptyLaneStartY - 160, {
    steps: 12,
  });
  await notificationMotion.mouse.up();
  await notificationMotion.waitForTimeout(280);
  assert(
    (await notificationCenter
      .getByTestId("home-notification-list")
      .getAttribute("data-shade-mode")) === "rested",
    "mouse swipe-up from the empty notification region collapses the shade",
  );
  await notificationCenter.getByTestId("notifications-count-button").click();
  await notificationMotion.waitForTimeout(300);
  assert(
    (await notificationCenter
      .getByTestId("home-notification-list")
      .getAttribute("data-shade-mode")) === "expanded",
    "notification shade reopens before the real-touch collapse",
  );

  await touchSwipe(
    notificationMotion,
    emptyTouchLaneSelector,
    0,
    -160,
    { steps: 12, stepDelayMs: 12 },
  );
  await notificationMotion.waitForTimeout(280);
  assert(
    (await notificationCenter
      .getByTestId("home-notification-list")
      .getAttribute("data-shade-mode")) === "rested",
    "real CDP touch swipe-up from the empty notification region collapses the shade",
  );
  await notificationCenter.getByTestId("notifications-count-button").click();
  await notificationMotion.waitForTimeout(300);
  assert(
    (await notificationCenter
      .getByTestId("home-notification-list")
      .getAttribute("data-shade-mode")) === "expanded",
    "notification shade reopens before the stack fan trace",
  );

  await notificationMotion.evaluate(() => {
    window.__ELIZA_NOTIFICATION_FAN_TRACE__ = [];
    const startedAt = performance.now();
    const sample = () => {
      const controls = document.querySelector(
        '[data-testid="notification-stack-controls"]',
      );
      const rows = Array.from(
        document.querySelectorAll("[data-notification-disposable-row]"),
      );
      const peeks = Array.from(
        document.querySelectorAll("[data-notification-stack-peek]"),
      );
      const group = document.querySelector(
        "[data-notification-group-content]",
      );
      window.__ELIZA_NOTIFICATION_FAN_TRACE__.push({
        t: performance.now() - startedAt,
        group: group
          ? {
              height: group.getBoundingClientRect().height,
              paddingBottom: Number.parseFloat(
                getComputedStyle(group).paddingBottom,
              ),
            }
          : null,
        controls: controls
          ? {
              height: controls.getBoundingClientRect().height,
              opacity: Number.parseFloat(getComputedStyle(controls).opacity),
              duration: getComputedStyle(controls).transitionDuration,
            }
          : null,
        rows: rows.map((row) => ({
          height: row.getBoundingClientRect().height,
          opacity: Number.parseFloat(getComputedStyle(row).opacity),
        })),
        peeks: peeks.map((peek) =>
          Number.parseFloat(getComputedStyle(peek).opacity),
        ),
      });
      if (performance.now() - startedAt < 420) requestAnimationFrame(sample);
    };
    const stackButton = document.querySelector(
      '[data-testid="notification-row"]',
    );
    if (!(stackButton instanceof HTMLButtonElement)) {
      throw new Error("missing notification stack button");
    }
    stackButton.click();
    requestAnimationFrame(sample);
  });
  await notificationMotion.waitForTimeout(460);
  const fanTrace = await notificationMotion.evaluate(
    () => window.__ELIZA_NOTIFICATION_FAN_TRACE__,
  );
  const mountedFanFrames = fanTrace.filter((sample) => sample.controls);
  const fanIntermediateOpacity = new Set(
    mountedFanFrames
      .map((sample) => sample.controls.opacity)
      .filter((opacity) => opacity > 0.05 && opacity < 0.95)
      .map((opacity) => opacity.toFixed(2)),
  );
  const fanIntermediateRowOpacity = new Set(
    mountedFanFrames
      .flatMap((sample) => sample.rows.map((row) => row.opacity))
      .filter((opacity) => opacity > 0.05 && opacity < 0.95)
      .map((opacity) => opacity.toFixed(2)),
  );
  const fanIntermediatePeekOpacity = new Set(
    mountedFanFrames
      .flatMap((sample) => sample.peeks)
      .filter((opacity) => opacity > 0.05 && opacity < 0.95)
      .map((opacity) => opacity.toFixed(2)),
  );
  assert(
    mountedFanFrames[0]?.controls.height < 1 &&
      mountedFanFrames[0]?.controls.opacity <= 0.05 &&
      mountedFanFrames[0]?.peeks.length === 2 &&
      mountedFanFrames[0]?.peeks.every((opacity) => opacity >= 0.98) &&
      mountedFanFrames[0]?.group.paddingBottom >= 15,
    "stack fan mounts controls and rows from collapsed geometry",
  );
  console.log(
    `  [notification stack fan] distinct intermediate frames=${fanIntermediateOpacity.size}`,
  );
  assert(
    fanIntermediateOpacity.size >= 2 &&
      fanIntermediateRowOpacity.size >= 2 &&
      fanIntermediatePeekOpacity.size >= 2,
    `stack fan produces intermediate control/row/peek frames (${fanIntermediateOpacity.size}/${fanIntermediateRowOpacity.size}/${fanIntermediatePeekOpacity.size})`,
  );
  assert(
    mountedFanFrames[0]?.controls.duration.includes("0.3s"),
    `stack fan uses the balanced 300ms settle (${mountedFanFrames[0]?.controls.duration ?? "missing"})`,
  );
  assert(
    mountedFanFrames.every(
      (sample, index) =>
        index === 0 ||
        sample.controls.opacity + 0.02 >=
          mountedFanFrames[index - 1].controls.opacity,
    ) &&
      mountedFanFrames.every(
        (sample, index) =>
          index === 0 ||
          sample.group.height + 1 >= mountedFanFrames[index - 1].group.height,
      ) &&
      mountedFanFrames.every(
        (sample, index) =>
          index === 0 ||
          sample.peeks.every(
            (opacity, peekIndex) =>
              opacity <=
              (mountedFanFrames[index - 1].peeks[peekIndex] ?? opacity) + 0.02,
          ),
      ),
    "stack fan geometry advances monotonically while its peeks fade",
  );
  assert(
    mountedFanFrames.at(-1)?.controls.height > 35 &&
      mountedFanFrames.at(-1)?.controls.opacity >= 0.98 &&
      mountedFanFrames.at(-1)?.rows.length === 2 &&
      mountedFanFrames.at(-1)?.peeks.length === 2 &&
      mountedFanFrames.at(-1)?.peeks.every((opacity) => opacity <= 0.02) &&
      Math.abs(mountedFanFrames.at(-1)?.group.paddingBottom - 16) < 0.75,
    "stack fan settles with controls and both folded rows visible",
  );

  await notificationMotion.evaluate(() => {
    window.__ELIZA_NOTIFICATION_FOLD_TRACE__ = [];
    const startedAt = performance.now();
    const sample = () => {
      const controls = document.querySelector(
        '[data-testid="notification-stack-controls"]',
      );
      const rows = Array.from(
        document.querySelectorAll("[data-notification-disposable-row]"),
      );
      const peeks = Array.from(
        document.querySelectorAll("[data-notification-stack-peek]"),
      );
      const group = document.querySelector(
        "[data-notification-group-content]",
      );
      const frontRow = group?.querySelector("[data-notif-row]");
      const restControl =
        document.querySelector('[data-testid="notifications-count"]') ??
        document.querySelector("[data-notification-collapse-footer]");
      const groupRect = group?.getBoundingClientRect();
      const frontRowRect = frontRow?.getBoundingClientRect();
      const groupShell = group?.closest("[data-notification-group]");
      const runningAnimations = (
        groupShell?.getAnimations({ subtree: true }) ?? []
      )
        .filter((animation) => {
          if (animation.playState !== "running") return false;
          const duration = animation.effect?.getComputedTiming().duration;
          return (
            typeof duration === "number" &&
            duration > 16 &&
            ("transitionProperty" in animation ||
              !("animationName" in animation))
          );
        })
        .map((animation) => {
          const target =
            animation.effect instanceof KeyframeEffect
              ? animation.effect.target
              : null;
          return {
            type: animation.constructor.name,
            property:
              "transitionProperty" in animation
                ? animation.transitionProperty
                : null,
            target:
              target instanceof Element
                ? target.getAttribute("data-testid") || target.className
                : null,
          };
        });
      window.__ELIZA_NOTIFICATION_FOLD_TRACE__.push({
        t: performance.now() - startedAt,
        group: groupRect
          ? { top: groupRect.top, height: groupRect.height }
          : null,
        frontRow: frontRowRect
          ? { top: frontRowRect.top, height: frontRowRect.height }
          : null,
        restControlTop: restControl?.getBoundingClientRect().top ?? null,
        runningAnimations,
        controls: controls
          ? {
              opacity: Number.parseFloat(getComputedStyle(controls).opacity),
              duration: getComputedStyle(controls).transitionDuration,
              timing: getComputedStyle(controls).transitionTimingFunction,
            }
          : null,
        rows: rows.map((row) =>
          Number.parseFloat(getComputedStyle(row).opacity),
        ),
        peeks: peeks.map((peek) =>
          Number.parseFloat(getComputedStyle(peek).opacity),
        ),
        peekTops: peeks.map((peek) => peek.getBoundingClientRect().top),
      });
      if (performance.now() - startedAt < 760) requestAnimationFrame(sample);
    };
    const showLess = document.querySelector(
      '[data-testid="notification-stack-collapse"]',
    );
    if (!(showLess instanceof HTMLButtonElement)) {
      throw new Error("missing Show Less control");
    }
    showLess.click();
    requestAnimationFrame(sample);
  });
  await notificationMotion.waitForTimeout(800);
  const foldTrace = await notificationMotion.evaluate(
    () => window.__ELIZA_NOTIFICATION_FOLD_TRACE__,
  );
  const mountedFoldFrames = foldTrace.filter((sample) => sample.controls);
  const foldIntermediateControlOpacity = new Set(
    mountedFoldFrames
      .map((sample) => sample.controls.opacity)
      .filter((opacity) => opacity > 0.05 && opacity < 0.95)
      .map((opacity) => opacity.toFixed(2)),
  );
  const foldIntermediateRowOpacity = new Set(
    mountedFoldFrames
      .flatMap((sample) => sample.rows)
      .filter((opacity) => opacity > 0.05 && opacity < 0.95)
      .map((opacity) => opacity.toFixed(2)),
  );
  const foldIntermediatePeekOpacity = new Set(
    mountedFoldFrames
      .flatMap((sample) => sample.peeks)
      .filter((opacity) => opacity > 0.05 && opacity < 0.95)
      .map((opacity) => opacity.toFixed(2)),
  );
  assert(
    mountedFoldFrames[0]?.controls.duration.includes("0.34s"),
    `stack fold uses the 340ms settle (${mountedFoldFrames[0]?.controls.duration ?? "missing"})`,
  );
  const foldTimingFunctions = new Set(
    (mountedFoldFrames[0]?.controls.timing ?? "")
      .split(",")
      .map((timing) => timing.trim())
      .filter(Boolean),
  );
  assert(
    foldTimingFunctions.size === 1 && foldTimingFunctions.has("ease"),
    `stack fold geometry and opacity share one ease curve (${mountedFoldFrames[0]?.controls.timing ?? "missing"})`,
  );
  assert(
    foldIntermediateControlOpacity.size >= 3 &&
      foldIntermediateRowOpacity.size >= 3 &&
      foldIntermediatePeekOpacity.size >= 3,
    `stack fold produces intermediate control/row/peek frames (${foldIntermediateControlOpacity.size}/${foldIntermediateRowOpacity.size}/${foldIntermediatePeekOpacity.size})`,
  );
  assert(
    mountedFoldFrames.every(
      (sample, index) =>
        index === 0 ||
        sample.controls.opacity <=
          mountedFoldFrames[index - 1].controls.opacity + 0.02,
    ) &&
      mountedFoldFrames.every(
        (sample, index) =>
          index === 0 ||
          sample.group.height <= mountedFoldFrames[index - 1].group.height + 1,
      ) &&
      mountedFoldFrames.every(
        (sample, index) =>
          index === 0 ||
          sample.peeks.every(
            (opacity, peekIndex) =>
              opacity + 0.02 >=
              (mountedFoldFrames[index - 1].peeks[peekIndex] ?? opacity),
          ),
      ),
    "stack fold geometry converges monotonically while its peeks return",
  );
  const settledFoldFrames = foldTrace.filter(
    (sample) =>
      sample.t >= 380 &&
      !sample.controls &&
      sample.group &&
      sample.frontRow &&
      sample.restControlTop !== null &&
      sample.peekTops.length === 2,
  );
  const settledFoldAnchor = settledFoldFrames[0];
  const foldTailDrift = settledFoldAnchor
    ? Math.max(
        ...settledFoldFrames.flatMap((sample) => [
          Math.abs(sample.group.top - settledFoldAnchor.group.top),
          Math.abs(sample.group.height - settledFoldAnchor.group.height),
          Math.abs(sample.frontRow.top - settledFoldAnchor.frontRow.top),
          Math.abs(sample.frontRow.height - settledFoldAnchor.frontRow.height),
          Math.abs(
            sample.restControlTop - settledFoldAnchor.restControlTop,
          ),
          ...sample.peekTops.map((top, index) =>
            Math.abs(top - settledFoldAnchor.peekTops[index]),
          ),
        ]),
      )
    : Number.POSITIVE_INFINITY;
  console.log(
    `  [notification stack fold tail] frames=${settledFoldFrames.length} max-drift=${foldTailDrift.toFixed(2)}px`,
  );
  assert(
    settledFoldFrames.length >= 20 &&
      foldTailDrift <= 0.5 &&
      settledFoldFrames.every(
        (sample) => sample.runningAnimations.length === 0,
      ),
    `stack fold has no second-phase animation or layout tail after its 340ms settle (${settledFoldFrames.length} frames, ${foldTailDrift.toFixed(2)}px drift, ${JSON.stringify(settledFoldFrames.find((sample) => sample.runningAnimations.length > 0)?.runningAnimations ?? [])})`,
  );
  assert(
    (await notificationCenter
      .getByTestId("notification-stack-collapse")
      .count()) === 0 &&
      (await notificationCenter.getByTestId("notification-stack").count()) ===
        1 &&
      (await notificationCenter
        .getByTestId("notification-stack-peek")
        .count()) === 2,
    "stack fold settles as one front card with two physical peeks",
  );
  await notificationCenter.getByTestId("notifications-collapse").click();
  await notificationMotion.waitForTimeout(280);
  assert(
    (await notificationCenter
      .getByTestId("home-notification-list")
      .getAttribute("data-shade-mode")) === "rested",
    "stack fold and collapse controls restore the rested shade",
  );

  const restedCountTop = (
    await notificationCenter.getByTestId("notifications-count").boundingBox()
  )?.y;
  if (restedCountTop === undefined) {
    throw new Error("missing cancelled-pull geometry");
  }
  const cancelledTouchPull = await touchDragHold(
    notificationMotion,
    '[data-testid="home-notification-list"]',
    0,
    48,
    { steps: 6, stepDelayMs: 16 },
  );
  await notificationMotion.waitForTimeout(32);
  const heldCountTop = (
    await notificationCenter.getByTestId("notifications-count").boundingBox()
  )?.y;
  await notificationMotion.evaluate((restTop) => {
    window.__ELIZA_NOTIFICATION_CANCEL_TRACE__ = [];
    const startedAt = performance.now();
    const sample = () => {
      const count = document.querySelector('[data-testid="notifications-count"]');
      const quietGroup = document.querySelector(
        "[data-notification-pull-reveal]",
      );
      const clearSlot = document.querySelector(
        "[data-notification-clear-slot]",
      );
      const clearButton = document.querySelector(
        '[data-testid="notifications-clear-all"]',
      );
      const collapseFooter = document.querySelector(
        "[data-notification-collapse-footer]",
      );
      if (count) {
        window.__ELIZA_NOTIFICATION_CANCEL_TRACE__.push({
          t: performance.now() - startedAt,
          offset: count.getBoundingClientRect().top - restTop,
          quietOpacity: quietGroup
            ? Number.parseFloat(getComputedStyle(quietGroup).opacity)
            : null,
          clearMounted: Boolean(clearButton),
          clearOpacity: clearSlot
            ? Number.parseFloat(getComputedStyle(clearSlot).opacity)
            : null,
          collapseMounted: Boolean(collapseFooter),
          collapseOpacity: collapseFooter
            ? Number.parseFloat(getComputedStyle(collapseFooter).opacity)
            : null,
        });
      }
      if (performance.now() - startedAt < 430) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, restedCountTop);
  const heldDirectManipulation = await notificationMotion.evaluate(() => {
    const quietGroup = document.querySelector(
      "[data-notification-pull-reveal]",
    );
    const collapseFooter = document.querySelector(
      "[data-notification-collapse-footer]",
    );
    return {
      quietDuration: quietGroup
        ? getComputedStyle(quietGroup).transitionDuration
        : "missing",
      collapseDuration: collapseFooter
        ? getComputedStyle(collapseFooter).transitionDuration
        : "missing",
    };
  });
  assert(
    heldDirectManipulation.quietDuration === "0s" &&
      heldDirectManipulation.collapseDuration === "0s",
    `active pull surfaces track the pointer without easing (${JSON.stringify(heldDirectManipulation)})`,
  );
  await cancelledTouchPull.release();
  const cancelStyle = await notificationMotion.evaluate(() => {
    const center = document.querySelector(
      '[data-testid="home-notification-center"]',
    );
    const count = document.querySelector('[data-testid="notifications-count"]');
    const quietGroup = document.querySelector(
      "[data-notification-pull-reveal]",
    );
    const clearButton = document.querySelector(
      '[data-testid="notifications-clear-all"]',
    );
    const collapseFooter = document.querySelector(
      "[data-notification-collapse-footer]",
    );
    return {
      active: center?.hasAttribute("data-notification-shade-cancelling"),
      duration: count ? getComputedStyle(count).transitionDuration : "",
      quietMounted: Boolean(quietGroup),
      quietDuration: quietGroup
        ? getComputedStyle(quietGroup).transitionDuration
        : "",
      clearMounted: Boolean(clearButton),
      collapseMounted: Boolean(collapseFooter),
      collapseDuration: collapseFooter
        ? getComputedStyle(collapseFooter).transitionDuration
        : "",
    };
  });
  await notificationMotion.waitForTimeout(450);
  const cancelTrace = await notificationMotion.evaluate(
    () => window.__ELIZA_NOTIFICATION_CANCEL_TRACE__,
  );
  const heldOffset = (heldCountTop ?? restedCountTop) - restedCountTop;
  const cancelAt100 = cancelTrace.find((sample) => sample.t >= 100);
  assert(
    cancelStyle.active &&
      cancelStyle.duration.includes("0.34s") &&
      cancelStyle.quietMounted &&
      cancelStyle.quietDuration.includes("0.34s") &&
      cancelStyle.clearMounted &&
      cancelStyle.collapseMounted &&
      cancelStyle.collapseDuration.includes("0.34s"),
    `cancelled pull keeps every preview surface on the softer 340ms settle (${JSON.stringify(cancelStyle)})`,
  );
  assert(
    Math.abs(cancelAt100?.offset ?? 0) > Math.abs(heldOffset) * 0.1,
    "cancelled pull remains visibly in flight after 100ms",
  );
  assert(
    (cancelAt100?.quietOpacity ?? 0) > 0.01 &&
      cancelAt100?.clearMounted === true &&
      (cancelAt100?.clearOpacity ?? 0) > 0.01 &&
      cancelAt100?.collapseMounted === true &&
      (cancelAt100?.collapseOpacity ?? 0) > 0.01,
    "quiet group, clear control, and collapse footer remain visibly in flight after 100ms",
  );
  assert(
    Math.abs(cancelTrace.at(-1)?.offset ?? Number.POSITIVE_INFINITY) < 0.75,
    "cancelled pull settles exactly back at rest",
  );
  assert(
    cancelTrace.at(-1)?.quietOpacity === null &&
      cancelTrace.at(-1)?.clearMounted === false &&
      cancelTrace.at(-1)?.collapseMounted === false,
    "cancelled pull unmounts preview-only surfaces only after the settle completes",
  );

  await notificationMotion.emulateMedia({ reducedMotion: "reduce" });
  await notificationMotion.waitForFunction(() =>
    document
      .querySelector('[data-testid="home-notification-center"]')
      ?.hasAttribute("data-notification-reduced-motion"),
  );
  const reducedCountButton = notificationCenter.getByTestId(
    "notifications-count-button",
  );
  await reducedCountButton.focus();
  await notificationMotion.keyboard.press("Enter");
  const reducedOpen = await notificationMotion.evaluate(() => {
    const center = document.querySelector(
      '[data-testid="home-notification-center"]',
    );
    const list = document.querySelector(
      '[data-testid="home-notification-list"]',
    );
    const group = document.querySelector(
      "[data-notification-group-content]",
    );
    const count = document.querySelector('[data-testid="notifications-count"]');
    return {
      mode: list?.getAttribute("data-shade-mode"),
      groupOpacity: group
        ? Number.parseFloat(getComputedStyle(group).opacity)
        : -1,
      groupDuration: group ? getComputedStyle(group).transitionDuration : "",
      countHeight: count?.getBoundingClientRect().height ?? -1,
      countDuration: count ? getComputedStyle(count).transitionDuration : "",
      activeTestId: document.activeElement?.getAttribute("data-testid"),
      materialRunningAnimations:
        center instanceof Element
          ? center
              .getAnimations({ subtree: true })
              .filter((animation) => {
                const duration = animation.effect?.getComputedTiming().duration;
                return (
                  animation.playState === "running" &&
                  typeof duration === "number" &&
                  duration > 16
                );
              })
              .map((animation) => {
                const effect = animation.effect;
                const target =
                  effect instanceof KeyframeEffect ? effect.target : null;
                return {
                  duration: effect?.getComputedTiming().duration,
                  name:
                    "animationName" in animation
                      ? animation.animationName
                      : undefined,
                  property:
                    "transitionProperty" in animation
                      ? animation.transitionProperty
                      : undefined,
                  target:
                    target instanceof Element
                      ? target.getAttribute("data-testid") || target.className
                      : null,
                };
              })
          : [],
    };
  });
  assert(
    reducedOpen.mode === "expanded" &&
      reducedOpen.groupOpacity >= 0.98 &&
      reducedOpen.countHeight < 0.75 &&
      reducedOpen.groupDuration === "0s" &&
      reducedOpen.countDuration === "0s" &&
      reducedOpen.activeTestId === "notification-row" &&
      reducedOpen.materialRunningAnimations.length === 0,
    `reduced-motion click-open is immediate and hands keyboard focus to the first row (${JSON.stringify(reducedOpen)})`,
  );
  await notificationMotion.keyboard.press("Enter");
  const reducedFan = await notificationMotion.evaluate(() => {
    const center = document.querySelector(
      '[data-testid="home-notification-center"]',
    );
    const controls = document.querySelector(
      '[data-testid="notification-stack-controls"]',
    );
    const peeks = Array.from(
      document.querySelectorAll("[data-notification-stack-peek]"),
    );
    return {
      controlsHeight: controls?.getBoundingClientRect().height ?? -1,
      controlsOpacity: controls
        ? Number.parseFloat(getComputedStyle(controls).opacity)
        : -1,
      controlsDuration: controls
        ? getComputedStyle(controls).transitionDuration
        : "",
      peekOpacities: peeks.map((peek) =>
        Number.parseFloat(getComputedStyle(peek).opacity),
      ),
      activeTestId: document.activeElement?.getAttribute("data-testid"),
      materialRunningAnimations:
        center instanceof Element
          ? center
              .getAnimations({ subtree: true })
              .filter((animation) => {
                const duration = animation.effect?.getComputedTiming().duration;
                return (
                  animation.playState === "running" &&
                  typeof duration === "number" &&
                  duration > 16
                );
              })
              .map((animation) => {
                const effect = animation.effect;
                const target =
                  effect instanceof KeyframeEffect ? effect.target : null;
                return {
                  duration: effect?.getComputedTiming().duration,
                  name:
                    "animationName" in animation
                      ? animation.animationName
                      : undefined,
                  property:
                    "transitionProperty" in animation
                      ? animation.transitionProperty
                      : undefined,
                  target:
                    target instanceof Element
                      ? target.getAttribute("data-testid") || target.className
                      : null,
                };
              })
          : [],
    };
  });
  assert(
    reducedFan.controlsHeight > 35 &&
      reducedFan.controlsOpacity >= 0.98 &&
      reducedFan.controlsDuration === "0s" &&
      reducedFan.peekOpacities.length === 2 &&
      reducedFan.peekOpacities.every((opacity) => opacity <= 0.02) &&
      reducedFan.activeTestId === "notification-stack-collapse" &&
      reducedFan.materialRunningAnimations.length === 0,
    `reduced-motion stack fan is immediate and hands focus to Show Less (${JSON.stringify(reducedFan)})`,
  );
  await notificationMotion.keyboard.press("Enter");
  const reducedFold = await notificationMotion.evaluate(() => ({
    mode: document
      .querySelector('[data-testid="home-notification-list"]')
      ?.getAttribute("data-shade-mode"),
    stackControls: document.querySelectorAll(
      '[data-testid="notification-stack-controls"]',
    ).length,
    activeTestId: document.activeElement?.getAttribute("data-testid"),
  }));
  assert(
    reducedFold.mode === "expanded" &&
      reducedFold.stackControls === 0 &&
      reducedFold.activeTestId === "notification-row",
    `reduced-motion stack fold immediately returns focus to its top row (${JSON.stringify(reducedFold)})`,
  );
  const reducedCollapse = notificationCenter.getByTestId(
    "notifications-collapse",
  );
  await reducedCollapse.focus();
  await notificationMotion.keyboard.press("Enter");
  const reducedClose = await notificationMotion.evaluate(() => {
    const list = document.querySelector(
      '[data-testid="home-notification-list"]',
    );
    const count = document.querySelector('[data-testid="notifications-count"]');
    const countButton = document.querySelector(
      '[data-testid="notifications-count-button"]',
    );
    return {
      mode: list?.getAttribute("data-shade-mode"),
      countHeight: count?.getBoundingClientRect().height ?? -1,
      expanded: countButton?.getAttribute("aria-expanded"),
      collapseControls: document.querySelectorAll(
        '[data-testid="notifications-collapse"]',
      ).length,
      activeTestId: document.activeElement?.getAttribute("data-testid"),
    };
  });
  assert(
    reducedClose.mode === "rested" &&
      reducedClose.countHeight > 31 &&
      reducedClose.expanded === "false" &&
      reducedClose.collapseControls === 0 &&
      reducedClose.activeTestId === "notifications-count-button",
    `reduced-motion collapse commits DOM, ARIA, and reverse focus immediately (${JSON.stringify(reducedClose)})`,
  );
  await touchSwipe(
    notificationMotion,
    '[data-testid="home-notification-list"]',
    0,
    48,
    {
    steps: 6,
      stepDelayMs: 8,
    },
  );
  const reducedCancel = await notificationMotion.evaluate(() => ({
    mode: document
      .querySelector('[data-testid="home-notification-list"]')
      ?.getAttribute("data-shade-mode"),
    cancelling: document
      .querySelector('[data-testid="home-notification-center"]')
      ?.hasAttribute("data-notification-shade-cancelling"),
    previewGroups: document.querySelectorAll(
      "[data-notification-pull-reveal]",
    ).length,
    clearControls: document.querySelectorAll(
      '[data-testid="notifications-clear-all"]',
    ).length,
    collapseControls: document.querySelectorAll(
      '[data-testid="notifications-collapse"]',
    ).length,
  }));
  assert(
    reducedCancel.mode === "rested" &&
      reducedCancel.cancelling === false &&
      reducedCancel.previewGroups === 0 &&
      reducedCancel.clearControls === 0 &&
      reducedCancel.collapseControls === 0,
    `reduced-motion short pull resets preview DOM immediately (${JSON.stringify(reducedCancel)})`,
  );
  await notificationMotion.emulateMedia({ reducedMotion: "no-preference" });
  await notificationMotion.waitForFunction(
    () =>
      !document
        .querySelector('[data-testid="home-notification-center"]')
        ?.hasAttribute("data-notification-reduced-motion"),
  );

  // Reload into a clean shade before the deep-pull marker trace. Keeping this
  // proof isolated prevents its release-click suppression from changing the
  // interaction sequence exercised above.
  await notificationMotion.goto(`${url}?notificationMaterialMotion`);
  await notificationCenter.waitFor({ state: "visible", timeout: 5000 });
  await waitForHomeEnterSettled(notificationMotion);
  await notificationMotion.evaluate(() => {
    window.__ELIZA_NOTIFICATION_DEEP_PULL_TRACE__ = [];
    const startedAt = performance.now();
    const sample = () => {
      const list = document.querySelector(
        '[data-testid="home-notification-list"]',
      );
      const row = document.querySelector(".eliza-notif-row");
      const glass = row?.querySelector(".eliza-notif-glass");
      const rowStyle = row ? getComputedStyle(row) : null;
      const groupContents = Array.from(
        document.querySelectorAll("[data-notification-group-content]"),
      );
      const stackPeeks = Array.from(
        document.querySelectorAll("[data-notification-stack-peek]"),
      );
      const listStyle = list ? getComputedStyle(list) : null;
      window.__ELIZA_NOTIFICATION_DEEP_PULL_TRACE__.push({
        t: performance.now() - startedAt,
        mode: list?.getAttribute("data-shade-mode"),
        dragging: list?.hasAttribute("data-shade-dragging"),
        releaseSettling: list?.hasAttribute("data-shade-release-settling"),
        maskImage: listStyle?.maskImage ?? null,
        webkitMaskImage: listStyle?.webkitMaskImage ?? null,
        groupOpacities: groupContents.map((group) =>
          Number.parseFloat(getComputedStyle(group).opacity),
        ),
        peekOpacities: stackPeeks.map((peek) =>
          Number.parseFloat(getComputedStyle(peek).opacity),
        ),
        peekColors: stackPeeks.map(
          (peek) => getComputedStyle(peek).backgroundColor,
        ),
        peekImages: stackPeeks.map(
          (peek) => getComputedStyle(peek).backgroundImage,
        ),
        peekShadows: stackPeeks.map(
          (peek) => getComputedStyle(peek).boxShadow,
        ),
        row: rowStyle
          ? {
              animationName: rowStyle.animationName,
              opacity: Number.parseFloat(rowStyle.opacity),
              transform: rowStyle.transform,
              backgroundColor: glass
                ? getComputedStyle(glass).backgroundColor
                : null,
            }
          : null,
      });
      if (performance.now() - startedAt < 1_000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await touchSwipe(
    notificationMotion,
    '[data-testid="home-notification-list"]',
    0,
    420,
    { steps: 12, stepDelayMs: 12 },
  );
  await notificationMotion.waitForTimeout(700);
  const deepPullTrace = await notificationMotion.evaluate(
    () => window.__ELIZA_NOTIFICATION_DEEP_PULL_TRACE__,
  );
  const expandedDeepPullFrames = deepPullTrace.filter(
    (sample) => sample.mode === "expanded" && sample.row,
  );
  const heldDeepPullFrames = deepPullTrace.filter(
    (sample) =>
      sample.mode === "rested" &&
      sample.dragging &&
      sample.groupOpacities.length > 0,
  );
  const settledDeepPullFrames = expandedDeepPullFrames.filter(
    (sample) => !sample.releaseSettling,
  );
  const releasingDeepPullFrames = expandedDeepPullFrames.filter(
    (sample) => sample.releaseSettling,
  );
  const expandedGlassColors = new Set(
    expandedDeepPullFrames
      .map((sample) => sample.row.backgroundColor)
      .filter(Boolean),
  );
  assert(
    expandedDeepPullFrames.some((sample) => sample.releaseSettling) &&
      settledDeepPullFrames.length > 0,
    "deep pull trace spans the release marker handoff",
  );
  assert(
    heldDeepPullFrames.some(
      (sample) =>
        sample.groupOpacities.every((opacity) => opacity >= 0.99) &&
        sample.groupOpacities.length === 2 &&
        sample.peekOpacities.length === 4 &&
        sample.peekOpacities.every((opacity) => opacity >= 0.99),
    ),
    "held deep pull advances both mounted stacks and all four backplates to full opacity",
  );
  const expandedPeekColors = new Set(
    expandedDeepPullFrames.flatMap((sample) => sample.peekColors),
  );
  const expandedPeekImages = new Set(
    expandedDeepPullFrames.flatMap((sample) => sample.peekImages),
  );
  const expandedPeekShadows = new Set(
    expandedDeepPullFrames.flatMap((sample) => sample.peekShadows),
  );
  assert(
    expandedDeepPullFrames.every(
      (sample) =>
        sample.groupOpacities.length === 2 &&
        sample.groupOpacities.every((opacity) => opacity >= 0.99) &&
        sample.peekOpacities.length === 4 &&
        sample.peekOpacities.every((opacity) => opacity >= 0.99),
    ) &&
      expandedPeekColors.size === 1 &&
      expandedPeekImages.size === 1 &&
      expandedPeekShadows.size === 1,
    `deep-pull release keeps every stack backplate at one opacity and material (${JSON.stringify({ expandedPeekColors: [...expandedPeekColors], expandedPeekImages: [...expandedPeekImages], expandedPeekShadows: [...expandedPeekShadows], firstFrames: expandedDeepPullFrames.slice(0, 4) })})`,
  );
  assert(
    releasingDeepPullFrames.length > 0 &&
      releasingDeepPullFrames.every(
        (sample) =>
          sample.maskImage === "none" && sample.webkitMaskImage === "none",
      ) &&
      settledDeepPullFrames.some(
        (sample) =>
          sample.maskImage !== "none" && sample.webkitMaskImage !== "none",
      ),
    `release runway stays unmasked until both stacks settle (${JSON.stringify({ releasing: releasingDeepPullFrames.slice(0, 3), settled: settledDeepPullFrames.slice(0, 2) })})`,
  );
  assert(
    expandedDeepPullFrames.every(
      (sample) => sample.row.animationName === "none",
    ),
    "expanded notification rows never reactivate their view-timeline animation",
  );
  assert(
    settledDeepPullFrames.every(
      (sample) =>
        sample.row.opacity >= 0.99 &&
        (sample.row.transform === "none" ||
          sample.row.transform === "matrix(1, 0, 0, 1, 0, 0)"),
    ) && expandedGlassColors.size === 1,
    `deep-pull marker clear preserves settled row opacity/transform/material (${JSON.stringify({ settledDeepPullFrames: settledDeepPullFrames.slice(-3), expandedGlassColors: [...expandedGlassColors] })})`,
  );
  await notificationMotion.close();
  await notificationMotionContext.close();

  // A short mobile viewport with enough independent producers to overflow
  // proves the expanded shade consumes the column's live safe-bottom region.
  // The home column owns the composer clearance, so the notification center
  // must follow that boundary rather than introducing its own viewport cap.
  const notificationGeometryContext = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  const notificationGeometry = await notificationGeometryContext.newPage();
  notificationGeometry.on("pageerror", (e) => sink.errors.push(String(e)));
  await installCoarsePointerMedia(notificationGeometry);
  await notificationGeometry.goto(`${url}?notificationOverflow`);
  await notificationGeometry
    .getByTestId("home-notification-center")
    .waitFor({ state: "visible", timeout: 5000 });
  await waitForHomeEnterSettled(notificationGeometry);

  const readShadeLayoutGeometry = () =>
    notificationGeometry.evaluate(() => {
      const column = document.querySelector(
        '[data-testid="home-content-column"]',
      );
      const center = document.querySelector(
        '[data-testid="home-notification-center"]',
      );
      const list = document.querySelector(
        '[data-testid="home-notification-list"]',
      );
      const secondary = document.querySelector(
        "[data-home-below-notifications]",
      );
      if (
        !(column instanceof HTMLElement) ||
        !(center instanceof HTMLElement) ||
        !(list instanceof HTMLElement) ||
        !(secondary instanceof HTMLElement)
      ) {
        return null;
      }
      return {
        mode: list.getAttribute("data-shade-mode"),
        preview: list.getAttribute("data-shade-preview"),
        dragging: list.hasAttribute("data-shade-dragging"),
        settling: list.hasAttribute("data-shade-settling"),
        cancelling: center.hasAttribute(
          "data-notification-shade-cancelling",
        ),
        columnBottom: column.getBoundingClientRect().bottom,
        centerBottom: center.getBoundingClientRect().bottom,
        secondary: {
          height: secondary.getBoundingClientRect().height,
          visibility: getComputedStyle(secondary).visibility,
          transitionDuration: getComputedStyle(secondary).transitionDuration,
        },
        layoutDuration: column.style.getPropertyValue(
          "--eliza-home-notification-settle-duration",
        ),
      };
    });

  // Holding a sub-threshold pull proves the preview receives the expanded
  // runway before commit. Releasing it must reverse the same grid track while
  // preview DOM is still mounted, with no second layout tail after cancellation.
  const previewRestGeometry = await readShadeLayoutGeometry();
  const previewListBox = await notificationGeometry
    .getByTestId("home-notification-list")
    .boundingBox();
  assert(previewListBox !== null, "preview list geometry is measurable");
  if (previewListBox) {
    const previewX = previewListBox.x + previewListBox.width / 2;
    const previewY = previewListBox.y + previewListBox.height / 2;
    await notificationGeometry.mouse.move(previewX, previewY);
    await notificationGeometry.mouse.down();
    for (let step = 1; step <= 5; step += 1) {
      await notificationGeometry.mouse.move(
        previewX,
        previewY + (30 * step) / 5,
      );
      await notificationGeometry.waitForTimeout(25);
    }
    await notificationGeometry.waitForTimeout(360);
    const heldPreviewGeometry = await readShadeLayoutGeometry();
    assert(
      previewRestGeometry !== null &&
        heldPreviewGeometry !== null &&
        heldPreviewGeometry.preview === "expanding" &&
        heldPreviewGeometry.dragging &&
        heldPreviewGeometry.secondary.height <= 1 &&
        heldPreviewGeometry.secondary.visibility === "hidden" &&
        Math.abs(
          heldPreviewGeometry.centerBottom - heldPreviewGeometry.columnBottom,
        ) <= 2,
      `active pull preview reaches the composer-safe boundary (${JSON.stringify({ previewRestGeometry, heldPreviewGeometry })})`,
    );

    await notificationGeometry.mouse.up();
    const cancelStartGeometry = await readShadeLayoutGeometry();
    await notificationGeometry.waitForTimeout(100);
    const cancelMidGeometry = await readShadeLayoutGeometry();
    const cancelDurationMs = Number.parseFloat(
      cancelStartGeometry?.layoutDuration ?? "460",
    );
    await notificationGeometry.waitForTimeout(
      Math.max(0, cancelDurationMs + 60 - 100),
    );
    const cancelSettledGeometry = await readShadeLayoutGeometry();
    await notificationGeometry.waitForTimeout(220);
    const cancelTailGeometry = await readShadeLayoutGeometry();
    assert(
      previewRestGeometry !== null &&
        heldPreviewGeometry !== null &&
        cancelStartGeometry !== null &&
        cancelMidGeometry !== null &&
        cancelSettledGeometry !== null &&
        cancelTailGeometry !== null &&
        cancelStartGeometry.mode === "rested" &&
        cancelStartGeometry.preview === "expanding" &&
        !cancelStartGeometry.dragging &&
        cancelStartGeometry.cancelling &&
        cancelMidGeometry.secondary.height >
          heldPreviewGeometry.secondary.height + 1 &&
        cancelSettledGeometry.preview === null &&
        !cancelSettledGeometry.cancelling &&
        Math.abs(
          cancelSettledGeometry.secondary.height -
            previewRestGeometry.secondary.height,
        ) <= 1 &&
        Math.abs(
          cancelTailGeometry.secondary.height -
            cancelSettledGeometry.secondary.height,
        ) <= 1 &&
        Math.abs(
          cancelTailGeometry.centerBottom -
            cancelSettledGeometry.centerBottom,
        ) <= 1,
      `cancelled pull reverses its layout on one settle clock (${JSON.stringify({ cancelStartGeometry, cancelMidGeometry, cancelSettledGeometry, cancelTailGeometry })})`,
    );
  }

  await notificationGeometry
    .getByTestId("notifications-count-button")
    .click();
  await notificationGeometry.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="home-notification-list"]')
        ?.getAttribute("data-shade-mode") === "expanded",
  );
  await notificationGeometry.waitForTimeout(520);

  const readExpandedGeometry = () =>
    notificationGeometry.evaluate(() => {
      const home = document.querySelector('[data-testid="home-screen"]');
      const column = document.querySelector(
        '[data-testid="home-content-column"]',
      );
      const center = document.querySelector(
        '[data-testid="home-notification-center"]',
      );
      const list = document.querySelector(
        '[data-testid="home-notification-list"]',
      );
      const secondary = document.querySelector(
        "[data-home-below-notifications]",
      );
      const clear = document.querySelector(
        '[data-testid="notifications-clear-all"]',
      );
      const clearLabel = clear?.querySelector(
        "[data-notification-clear-resting-label]",
      );
      const clearIcon = clear?.querySelector("svg");
      if (
        !(home instanceof HTMLElement) ||
        !(column instanceof HTMLElement) ||
        !(center instanceof HTMLElement) ||
        !(list instanceof HTMLElement) ||
        !(secondary instanceof HTMLElement) ||
        !(clear instanceof HTMLElement) ||
        !(clearLabel instanceof HTMLElement) ||
        !(clearIcon instanceof SVGElement)
      ) {
        return null;
      }
      const rect = (element) => {
        const bounds = element.getBoundingClientRect();
        return {
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
          left: bounds.left,
          width: bounds.width,
          height: bounds.height,
        };
      };
      return {
        home: rect(home),
        column: rect(column),
        center: rect(center),
        list: {
          ...rect(list),
          clientHeight: list.clientHeight,
          scrollHeight: list.scrollHeight,
        },
        secondary: {
          ...rect(secondary),
          visibility: getComputedStyle(secondary).visibility,
        },
        homePaddingBottom: Number.parseFloat(
          getComputedStyle(home).paddingBottom,
        ),
        clear: {
          ...rect(clear),
          labelOpacity: Number.parseFloat(
            getComputedStyle(clearLabel).opacity,
          ),
          iconOpacity: Number.parseFloat(getComputedStyle(clearIcon).opacity),
        },
      };
    });

  const initialExpandedGeometry = await readExpandedGeometry();
  assert(
    initialExpandedGeometry !== null,
    "expanded overflow geometry is measurable",
  );
  if (initialExpandedGeometry) {
    assert(
      initialExpandedGeometry.secondary.height <= 1 &&
        initialExpandedGeometry.secondary.visibility === "hidden",
      `expanded shade folds secondary home content (${JSON.stringify(initialExpandedGeometry.secondary)})`,
    );
    assert(
      Math.abs(
        initialExpandedGeometry.center.bottom -
          initialExpandedGeometry.column.bottom,
      ) <= 2,
      `expanded notification center reaches the composer-safe column bottom (${JSON.stringify({ centerBottom: initialExpandedGeometry.center.bottom, columnBottom: initialExpandedGeometry.column.bottom })})`,
    );
    assert(
      Math.abs(
        initialExpandedGeometry.column.bottom -
          (initialExpandedGeometry.home.bottom -
            initialExpandedGeometry.homePaddingBottom),
      ) <= 2,
      `home column ends at the live bottom clearance (${JSON.stringify({ homeBottom: initialExpandedGeometry.home.bottom, paddingBottom: initialExpandedGeometry.homePaddingBottom, columnBottom: initialExpandedGeometry.column.bottom })})`,
    );
    assert(
      initialExpandedGeometry.list.scrollHeight >
        initialExpandedGeometry.list.clientHeight + 2,
      `overflowing expanded notifications scroll inside their available region (${JSON.stringify(initialExpandedGeometry.list)})`,
    );
    assert(
      initialExpandedGeometry.clear.width >= 55 &&
        initialExpandedGeometry.clear.labelOpacity >= 0.99 &&
        initialExpandedGeometry.clear.iconOpacity <= 0.01,
      `coarse-pointer clear control visibly rests as “Clear all” (${JSON.stringify(initialExpandedGeometry.clear)})`,
    );
  }

  await notificationGeometry.evaluate(
    () =>
      document.documentElement.style.setProperty(
        "--eliza-continuous-chat-clearance",
        "7rem",
      ),
  );
  await notificationGeometry.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const adjustedExpandedGeometry = await readExpandedGeometry();
  if (initialExpandedGeometry && adjustedExpandedGeometry) {
    const expectedClearanceDelta = (7 - 5.25) * 16;
    assert(
      Math.abs(
        initialExpandedGeometry.column.bottom -
          adjustedExpandedGeometry.column.bottom -
          expectedClearanceDelta,
      ) <= 2 &&
        Math.abs(
          adjustedExpandedGeometry.center.bottom -
            adjustedExpandedGeometry.column.bottom,
        ) <= 2,
      `expanded shade follows a live composer-clearance change (${JSON.stringify({ before: initialExpandedGeometry.column.bottom, after: adjustedExpandedGeometry.column.bottom, expectedClearanceDelta })})`,
    );
  }

  const closeStartExpandedGeometry = await readShadeLayoutGeometry();
  await notificationGeometry.getByTestId("notifications-collapse").click();
  const closeStartGeometry = await readShadeLayoutGeometry();
  await notificationGeometry.waitForTimeout(120);
  const closeMidGeometry = await readShadeLayoutGeometry();
  const closeDurationMs = Number.parseFloat(
    closeStartGeometry?.layoutDuration ?? "460",
  );
  await notificationGeometry.waitForTimeout(
    Math.max(0, closeDurationMs + 60 - 120),
  );
  const closeSettledGeometry = await readShadeLayoutGeometry();
  await notificationGeometry.waitForTimeout(220);
  const closeTailGeometry = await readShadeLayoutGeometry();
  assert(
    closeStartExpandedGeometry !== null &&
      closeStartGeometry !== null &&
      closeMidGeometry !== null &&
      closeSettledGeometry !== null &&
      closeTailGeometry !== null &&
      closeStartGeometry.mode === "expanded" &&
      closeStartGeometry.settling &&
      closeMidGeometry.secondary.height >
        closeStartGeometry.secondary.height + 1 &&
      closeMidGeometry.centerBottom <
        closeStartExpandedGeometry.centerBottom - 1 &&
      closeSettledGeometry.mode === "rested" &&
      !closeSettledGeometry.settling &&
      Math.abs(
        closeTailGeometry.secondary.height -
          closeSettledGeometry.secondary.height,
      ) <= 1 &&
      Math.abs(
        closeTailGeometry.centerBottom - closeSettledGeometry.centerBottom,
      ) <= 1,
    `committed close restores secondary content on the shade clock with no layout tail (${JSON.stringify({ closeStartGeometry, closeMidGeometry, closeSettledGeometry, closeTailGeometry })})`,
  );

  await notificationGeometry.goto(`${url}?notificationMotion`);
  await notificationGeometry
    .getByTestId("home-notification-center")
    .waitFor({ state: "visible", timeout: 5000 });
  await waitForHomeEnterSettled(notificationGeometry);
  await notificationGeometry
    .getByTestId("notifications-count-button")
    .click();
  await notificationGeometry.waitForTimeout(520);
  const shortListGeometry = await notificationGeometry.evaluate(() => {
    const list = document.querySelector(
      '[data-testid="home-notification-list"]',
    );
    if (!(list instanceof HTMLElement)) return null;
    return {
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
    };
  });
  assert(
    shortListGeometry !== null &&
      shortListGeometry.scrollHeight <= shortListGeometry.clientHeight + 1,
    `short expanded notification content does not create a false scroll range (${JSON.stringify(shortListGeometry)})`,
  );
  await notificationGeometry.close();
  await notificationGeometryContext.close();

  // Measure the rail in a dedicated non-recording context. Video encoding is
  // intentionally excluded from the frame budget: the product never performs
  // that work, and including it turns encoder throughput into a false UI gate.
  const perfContext = await browser.newContext({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    storageState: mobileStorageState,
  });
  const perfMobile = await perfContext.newPage();
  perfMobile.on("pageerror", (e) => sink.errors.push(String(e)));
  await installCoarsePointerMedia(perfMobile);
  await perfMobile.addInitScript(FRAME_SAMPLER_INIT);
  await perfMobile.goto(`${url}?native&homeData=attention`);
  await perfMobile.waitForSelector('[data-testid="home-launcher-surface"]');
  await perfMobile.waitForSelector('[data-testid="home-screen"]');
  await waitForHomeEnterSettled(perfMobile);
  await touchSwipeLeft(perfMobile, "home-launcher-home-page");
  await waitForSurfacePageSettled(perfMobile, "launcher");

  // Sample independent windows of real frames, each covering three full
  // home↔launcher round-trips. Hard-fail on sustained jank through the same
  // shared frame-budget detector used by the chat performance gates.
  {
    const attempts = [];
    for (let attempt = 0; attempt < RAIL_SWIPE_ATTEMPTS; attempt += 1) {
      const result = await measureRailSwipeWindow(perfMobile);
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
  await perfMobile.close();
  await perfContext.close();

  // Desktop width
  const desktop = await browser.newPage({
    viewport: { width: 1180, height: 900 },
  });
  desktop.on("pageerror", (e) => sink.errors.push(String(e)));
  await desktop.goto(url);
  await desktop.waitForSelector('[data-testid="home-launcher-surface"]');
  await desktop.waitForSelector('[data-testid="home-screen"]');
  await desktop.waitForTimeout(500);
  // Off-AOSP: no pinned tiles at all - the tile grid is omitted entirely.
  assert(
    (await desktop.getByTestId("home-tiles").count()) === 0,
    "no pinned tiles off-AOSP (grid omitted)",
  );
  assert(
    (await desktop.getByTestId("home-tile-phone").count()) === 0,
    "phone tile hidden when native disabled",
  );
  // Desktop uses the same inline notification center and shade controls.
  {
    const center = desktop.getByTestId("home-notification-center");
    await center.waitFor({ state: "visible", timeout: 5000 });
    assert(
      (await center.getByTestId("notification-row").count()) === 1,
      "desktop home renders the inline notification inbox with the seeded row",
    );
    await center.getByTestId("notifications-count-button").click();
    await center
      .locator(
        '[data-testid="home-notification-list"][data-shade-mode="expanded"]',
      )
      .waitFor({ state: "visible", timeout: 5000 });
    assert(
      (await center.getByTestId("notifications-clear-all").count()) === 1 &&
        (await center.getByTestId("notifications-collapse").count()) === 1,
      "desktop opens the same clear and collapse controls",
    );
    await desktop.waitForTimeout(520);
    const clear = center.getByTestId("notifications-clear-all");
    const readClearGeometry = () =>
      clear.evaluate((button) => {
        const label = button.querySelector(
          "[data-notification-clear-resting-label]",
        );
        const icon = button.querySelector(
          "[data-notification-clear-resting-icon]",
        );
        const slot = button.closest("[data-notification-clear-slot]");
        const row = document.querySelector(
          '[data-testid="notification-row"]',
        );
        if (
          !(label instanceof HTMLElement) ||
          !(icon instanceof SVGElement) ||
          !(slot instanceof HTMLElement) ||
          !(row instanceof HTMLElement)
        ) {
          return null;
        }
        const rect = (element) => {
          const bounds = element.getBoundingClientRect();
          return {
            top: bounds.top,
            right: bounds.right,
            width: bounds.width,
            height: bounds.height,
          };
        };
        return {
          button: rect(button),
          slot: rect(slot),
          row: rect(row),
          labelOpacity: Number.parseFloat(getComputedStyle(label).opacity),
          iconOpacity: Number.parseFloat(getComputedStyle(icon).opacity),
        };
      });
    const clearRest = await readClearGeometry();
    await clear.hover();
    await desktop.waitForTimeout(220);
    const clearHover = await readClearGeometry();
    await desktop.mouse.move(0, 0);
    await desktop.waitForTimeout(220);
    const clearReturned = await readClearGeometry();
    assert(
      clearRest !== null &&
        clearHover !== null &&
        clearReturned !== null &&
        clearRest.button.width <= 33 &&
        clearHover.button.width >= 55 &&
        clearHover.labelOpacity >= 0.99 &&
        clearHover.iconOpacity <= 0.01 &&
        Math.abs(clearRest.button.right - clearHover.button.right) <= 1 &&
        Math.abs(clearRest.slot.width - clearHover.slot.width) <= 1 &&
        Math.abs(clearRest.row.top - clearHover.row.top) <= 1 &&
        clearReturned.button.width <= 33,
      `desktop clear reveals leftward without shifting its slot or cards (${JSON.stringify({ clearRest, clearHover, clearReturned })})`,
    );
    await center.getByTestId("notifications-collapse").click();
    await center
      .locator(
        '[data-testid="home-notification-list"][data-shade-mode="rested"]',
      )
      .waitFor({ state: "visible", timeout: 5000 });
  }
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
