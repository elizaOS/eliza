/**
 * The `Driver` seam between the abstract launcher-loop commands and a real
 * surface, plus the web/desktop-renderer implementation (`CdpTouchDriver`).
 *
 * A command (`commands.ts`) never touches a `Page` directly — it drives a
 * `Driver`, which realizes an abstract gesture as genuine input and reports back
 * an observation of the resulting DOM/state. The web driver uses trusted CDP
 * touch (`Input.dispatchTouchEvent`) through the shared `real-touch-gestures`
 * helpers — the same path a finger takes through the browser's hit-test /
 * `touch-action` / implicit-capture pipeline — so overscroll, `pointercancel`,
 * and click-swallow bugs are actually exercisable. Native lanes (Android
 * `AndroidInput`, iOS XCUITest) implement the same interface with their own
 * gesture primitives; `runLauncherLoop` is agnostic to which is wired in.
 */

import type { Page } from "playwright";
import { touchLongPress, touchSwipe, touchTap } from "../real-touch-gestures";

/** Test-id / selector contract the driver keys off (frozen, see #12179 D5). */
export const LAUNCHER_SELECTORS = {
  surface: '[data-testid="home-launcher-surface"]',
  rail: '[data-testid="home-launcher-rail"]',
  pageProbe: '[data-testid="home-launcher-page-probe"]',
  homePage: '[data-testid="home-launcher-home-page"]',
  launcherPage: '[data-testid="home-launcher-launcher-page"]',
  launcherScroll: '[data-testid="launcher-page-window"]',
  homeScreen: '[data-testid="home-screen"]',
  // The inline notification inbox on the home column (self-hidden when empty).
  notificationCenter: '[data-testid="home-notification-center"]',
  railPrevButton: '[data-testid="rail-pager-edge-prev"]',
  railNextButton: '[data-testid="rail-pager-edge-next"]',
  tile: (id: string) => `[data-testid="launcher-tile-${id}"]`,
} as const;

/**
 * A single observation of the real surface after an action, read atomically
 * from the page so `invariants.ts` compares one consistent snapshot against the
 * model. `railTransformX` is the rail's committed X translation at rest (px);
 * `activeElementInInert` is the focus-safety check; `blueSampleCount` counts
 * sampled elements whose computed color/background resolves to a blue hue (brand
 * gate, §D item 41). `consoleErrorCount` is cumulative for the page.
 */
export interface LauncherObservation {
  readonly dataPage: string | null;
  readonly probeText: string | null;
  readonly railTransformX: number;
  readonly homeInert: boolean;
  readonly launcherInert: boolean;
  readonly activeElementInInert: boolean;
  readonly launchCount: number;
  readonly viewportWidth: number;
  readonly blueSampleCount: number;
  readonly layoutShiftScore: number;
  readonly consoleErrorCount: number;
}

/**
 * The gesture/observation contract every platform lane implements. Gesture
 * methods perform trusted input and resolve once the surface has settled; the
 * accept/reject of a gesture is decided by the abstract model, so a driver only
 * has to faithfully realize the described motion.
 */
export interface Driver {
  /** Horizontal rail flick; `committed` picks distance+velocity that cross (or
   *  deliberately miss) the pager's commit threshold. */
  railSwipe(direction: "left" | "right", committed: boolean): Promise<void>;
  /** Click a rail edge chevron (desktop/fine-pointer path). */
  railEdgeButton(direction: "prev" | "next"): Promise<void>;
  /** Tap a launcher tile (real touch tap). */
  tapTile(tileId: string): Promise<void>;
  /** Long-press a launcher tile (hold, no move). */
  longPressTile(tileId: string): Promise<void>;
  /** Vertical scroll of the launcher grid by `dy` px (negative scrolls up). */
  scrollGrid(dy: number): Promise<void>;
  /** Vertical scroll of the home widget list by `dy` px. */
  scrollWidgets(dy: number): Promise<void>;
  /** Move keyboard focus one Tab step forward. */
  tabFocus(): Promise<void>;
  /** Read a single consistent observation of the surface. */
  observe(): Promise<LauncherObservation>;
}

/** How many launcher tiles the current fixture/app exposes (for tile actions). */
export async function readTileIds(page: Page): Promise<string[]> {
  return page.$$eval('[data-testid^="launcher-tile-"]', (nodes) =>
    nodes
      .map((n) => n.getAttribute("data-testid") ?? "")
      .map((t) => t.replace(/^launcher-tile-/, ""))
      .filter((id) => id.length > 0),
  );
}

/**
 * Install the console-error counter and layout-shift observer BEFORE the surface
 * mounts. Idempotent; call once per page in `runLauncherLoop` setup.
 */
export const LAUNCHER_LOOP_INIT_SCRIPT = `
(() => {
  const g = window;
  if (g.__ELIZA_LAUNCHER_LOOP_INSTALLED__) return;
  g.__ELIZA_LAUNCHER_LOOP_INSTALLED__ = true;
  g.__ELIZA_LAUNCHER_LOOP_CONSOLE_ERRORS__ = 0;
  const origError = console.error.bind(console);
  console.error = (...args) => {
    g.__ELIZA_LAUNCHER_LOOP_CONSOLE_ERRORS__ += 1;
    origError(...args);
  };
  g.addEventListener('error', () => {
    g.__ELIZA_LAUNCHER_LOOP_CONSOLE_ERRORS__ += 1;
  });
  g.addEventListener('unhandledrejection', () => {
    g.__ELIZA_LAUNCHER_LOOP_CONSOLE_ERRORS__ += 1;
  });
  g.__ELIZA_LAUNCHER_LOOP_CLS__ = 0;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          g.__ELIZA_LAUNCHER_LOOP_CLS__ += entry.value;
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {
    // layout-shift not supported (non-Chromium) — CLS stays 0, budget check skipped.
  }
})();
`;

/**
 * The serializable selector subset the page-side reader keys off (functions and
 * per-tile selectors don't cross the CDP bridge).
 */
interface ReaderSelectors {
  readonly surface: string;
  readonly rail: string;
  readonly pageProbe: string;
  readonly homePage: string;
  readonly launcherPage: string;
}

const READER_SELECTORS: ReaderSelectors = {
  surface: LAUNCHER_SELECTORS.surface,
  rail: LAUNCHER_SELECTORS.rail,
  pageProbe: LAUNCHER_SELECTORS.pageProbe,
  homePage: LAUNCHER_SELECTORS.homePage,
  launcherPage: LAUNCHER_SELECTORS.launcherPage,
};

/**
 * The page-side reader (runs in the browser via `page.evaluate`). Samples
 * computed styles across the surface for blue hues, reads the launcher
 * telemetry ring for the launch count, and snapshots the rail transform, inert
 * flags, and focus location — all in one pass so the returned observation is
 * internally consistent. Self-contained: no closure over module scope, so
 * Playwright can serialize it.
 */
function readObservation(sel: ReaderSelectors): LauncherObservation {
  const parseTranslateX = (transform: string): number => {
    if (!transform || transform === "none") return 0;
    const match = transform.match(/matrix\(([^)]+)\)/);
    if (match) {
      const parts = match[1].split(",").map((n) => Number.parseFloat(n.trim()));
      return parts.length >= 6 ? parts[4] : 0;
    }
    const match3d = transform.match(/matrix3d\(([^)]+)\)/);
    if (match3d) {
      const parts = match3d[1]
        .split(",")
        .map((n) => Number.parseFloat(n.trim()));
      return parts.length >= 13 ? parts[12] : 0;
    }
    return 0;
  };
  const isBlue = (color: string): boolean => {
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const [r, g, b, a] = m[1]
      .split(",")
      .map((n) => Number.parseFloat(n.trim()));
    if (a !== undefined && a === 0) return false;
    // Blue-dominant: blue clearly the largest channel and not a near-grey.
    return b > 90 && b - r > 40 && b - g > 40;
  };
  const w = window as unknown as {
    __ELIZA_VIEW_INTERACTION_TELEMETRY__?: { action?: string }[];
    __ELIZA_LAUNCHER_LOOP_CLS__?: number;
    __ELIZA_LAUNCHER_LOOP_CONSOLE_ERRORS__?: number;
  };
  const surface = document.querySelector(sel.surface);
  const rail = document.querySelector(sel.rail);
  const probe = document.querySelector(sel.pageProbe);
  const homePage = document.querySelector(sel.homePage);
  const launcherPage = document.querySelector(sel.launcherPage);
  const active = document.activeElement;
  const activeInInert = !!active?.closest("[inert]");
  let blue = 0;
  if (surface) {
    const nodes = surface.querySelectorAll("*");
    const cap = Math.min(nodes.length, 400);
    for (let i = 0; i < cap; i += 1) {
      const cs = getComputedStyle(nodes[i]);
      if (isBlue(cs.color) || isBlue(cs.backgroundColor)) blue += 1;
    }
  }
  const ring = w.__ELIZA_VIEW_INTERACTION_TELEMETRY__ ?? [];
  const launchCount = ring.filter((e) => e?.action === "launch").length;
  return {
    dataPage: surface ? surface.getAttribute("data-page") : null,
    probeText: probe ? probe.textContent : null,
    railTransformX: rail
      ? parseTranslateX(getComputedStyle(rail).transform)
      : 0,
    homeInert: homePage ? homePage.hasAttribute("inert") : false,
    launcherInert: launcherPage ? launcherPage.hasAttribute("inert") : false,
    activeElementInInert: activeInInert,
    launchCount,
    viewportWidth: window.innerWidth,
    blueSampleCount: blue,
    layoutShiftScore: w.__ELIZA_LAUNCHER_LOOP_CLS__ ?? 0,
    consoleErrorCount: w.__ELIZA_LAUNCHER_LOOP_CONSOLE_ERRORS__ ?? 0,
  };
}

interface CdpTouchDriverOptions {
  /** px distance for a committed rail flick (should clear the commit threshold). */
  readonly commitDistance?: number;
  /** px distance for a deliberately-rejected (settle-back) rail flick. */
  readonly rejectDistance?: number;
}

/**
 * Web / desktop-renderer driver. Realizes gestures with trusted CDP touch and
 * mouse; reads observations from the live DOM + telemetry ring. Requires a
 * `hasTouch: true` context for the touch gestures to be accepted.
 */
export class CdpTouchDriver implements Driver {
  private readonly commitDistance: number;
  private readonly rejectDistance: number;

  constructor(
    private readonly page: Page,
    options: CdpTouchDriverOptions = {},
  ) {
    this.commitDistance = options.commitDistance ?? 280;
    this.rejectDistance = options.rejectDistance ?? 24;
  }

  async railSwipe(
    direction: "left" | "right",
    committed: boolean,
  ): Promise<void> {
    const before = await this.readDataPage();
    const canNavigate =
      (direction === "left" && before === "home") ||
      (direction === "right" && before === "launcher");
    const expected =
      committed && canNavigate
        ? before === "home"
          ? "launcher"
          : "home"
        : before;

    const target =
      direction === "left"
        ? LAUNCHER_SELECTORS.homePage
        : LAUNCHER_SELECTORS.launcherPage;
    const dx = committed ? this.commitDistance : this.rejectDistance;
    const signedDx = direction === "left" ? -dx : dx;

    // Swipe with the proven rail recipe (10 steps, 16ms/step) from
    // run-home-screen-e2e. At the engine's original stepDelayMs 2, Chromium
    // coalesces the touchMove burst into one composited frame, the pager's
    // velocity tracker sees a single tiny jump, and the committing flick is
    // dropped — the rail never navigates. A CDP touch can also be dropped by the
    // compositor under load, so a committing navigation that fails to land is
    // re-dispatched, bounded; rejects and edge-of-rail swipes leave the page
    // unchanged, match on the first pass, and never retry, while a genuine
    // model/driver divergence lands on the wrong page and is caught downstream.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await touchSwipe(this.page, target, signedDx, 0, {
        steps: 10,
        stepDelayMs: 16,
      });
      await this.settle();
      if ((await this.readDataPage()) === expected) return;
    }
  }

  private async readDataPage(): Promise<string | null> {
    return this.page
      .locator(LAUNCHER_SELECTORS.surface)
      .first()
      .getAttribute("data-page");
  }

  async railEdgeButton(direction: "prev" | "next"): Promise<void> {
    const selector =
      direction === "prev"
        ? LAUNCHER_SELECTORS.railPrevButton
        : LAUNCHER_SELECTORS.railNextButton;
    const button = this.page.locator(selector).first();
    if ((await button.count()) === 0) return;
    if (!(await button.isVisible())) return;
    await button.click();
    await this.settle();
  }

  async tapTile(tileId: string): Promise<void> {
    // The launcher grid scrolls (`launcher-page-window` is `overflow-y-auto`), so
    // a prior gridScroll can push a tile off-window; its bounding box still
    // reports a nonzero rect, so a center touch-tap would land off-window and
    // launch nothing (a driver artifact, not a launcher bug — the model always
    // expects a tap to launch). Bring the tile into view first, exactly as a
    // real user scrolls to a tile before tapping it.
    await this.scrollTileIntoView(tileId);
    await touchTap(this.page, LAUNCHER_SELECTORS.tile(tileId));
    await this.settle();
  }

  async longPressTile(tileId: string): Promise<void> {
    await this.scrollTileIntoView(tileId);
    await touchLongPress(this.page, LAUNCHER_SELECTORS.tile(tileId), 650);
    await this.settle();
  }

  private async scrollTileIntoView(tileId: string): Promise<void> {
    const tile = this.page.locator(LAUNCHER_SELECTORS.tile(tileId)).first();
    // error-policy:J6 — best-effort centering; if the tile can't be scrolled
    // into view the tap below still runs and the launch-count invariant catches
    // a genuinely-unreachable tile loudly.
    await tile.scrollIntoViewIfNeeded().catch(() => undefined);
    await this.settle();
  }

  async scrollGrid(dy: number): Promise<void> {
    await touchSwipe(this.page, LAUNCHER_SELECTORS.launcherScroll, 0, -dy, {
      steps: 8,
      stepDelayMs: 1,
    });
    await this.settle();
  }

  async scrollWidgets(dy: number): Promise<void> {
    await touchSwipe(this.page, LAUNCHER_SELECTORS.homeScreen, 0, -dy, {
      steps: 8,
      stepDelayMs: 1,
    });
    await this.settle();
  }

  async tabFocus(): Promise<void> {
    await this.page.keyboard.press("Tab");
    await this.settle();
  }

  async observe(): Promise<LauncherObservation> {
    return this.page.evaluate(readObservation, READER_SELECTORS);
  }

  private async settle(): Promise<void> {
    // Wait for the rail to actually come to REST before the caller observes it:
    // every rail animation finished AND the transform parked at a page boundary
    // (0 or a whole -width multiple). A bare double-rAF returns mid-commit under
    // load, so the observation reads a transitioning rail and the invariant sees
    // `data-page` lagging the model (#12179). Page-agnostic, so it stays a driver
    // concern and doesn't duplicate the model's page tracking.
    // error-policy:J6 — the wait is a settle hint; on timeout (a genuinely stuck
    // rail) we fall through to observe, and transformAtRest reports it precisely.
    await this.page
      .waitForFunction(
        (selectors) => {
          const rail = document.querySelector(selectors.rail);
          const surface = document.querySelector(selectors.surface);
          if (
            !(rail instanceof HTMLElement) ||
            !(surface instanceof HTMLElement)
          ) {
            return false;
          }
          const animating = rail
            .getAnimations({ subtree: true })
            .some((a) => a.playState === "running");
          if (animating) return false;
          const railLeft = rail.getBoundingClientRect().left;
          const surfaceLeft = surface.getBoundingClientRect().left;
          const width = surface.getBoundingClientRect().width || 1;
          const offset = railLeft - surfaceLeft;
          return Math.abs(offset - Math.round(offset / width) * width) < 1.5;
        },
        { rail: LAUNCHER_SELECTORS.rail, surface: LAUNCHER_SELECTORS.surface },
        { timeout: 4000 },
      )
      .catch(() => undefined);
    await this.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  }
}
