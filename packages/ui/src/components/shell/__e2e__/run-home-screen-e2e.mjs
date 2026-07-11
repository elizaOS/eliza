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
// must be declared inline.
const headHtml = `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
<style>:root{--eliza-continuous-chat-clearance:5.25rem;--safe-area-bottom:0px;--eliza-mobile-nav-offset:0px;--brand-white:#fdfaf7;--brand-black:#000000;--brand-orange:#ff6a1f}</style>`;
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
