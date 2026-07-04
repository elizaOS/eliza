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
import {
  touchDragHold,
  touchLongPress,
  touchSwipe,
  touchTap,
} from "../real-touch-gestures";

/** Test-id / selector contract the driver keys off (frozen, see #12179 D5). */
export const LAUNCHER_SELECTORS = {
  surface: '[data-testid="home-launcher-surface"]',
  rail: '[data-testid="home-launcher-rail"]',
  pageProbe: '[data-testid="home-launcher-page-probe"]',
  homePage: '[data-testid="home-launcher-home-page"]',
  launcherPage: '[data-testid="home-launcher-launcher-page"]',
  launcherScroll: '[data-testid="launcher-page-window"]',
  homeScreen: '[data-testid="home-screen"]',
  notificationPullZone: '[data-testid="home-notification-pull-zone"]',
  railPrevButton: '[data-testid="rail-pager-edge-prev"]',
  railNextButton: '[data-testid="rail-pager-edge-next"]',
  tile: (id: string) => `[data-testid="launcher-tile-${id}"]`,
} as const;

/**
 * How an OPEN notification center is detected in the real DOM. `NotificationCenter`
 * renders the mobile pull-down as `notification-sheet` and the desktop dropdown as
 * `notification-panel`, each stamped `data-open` only while open — there is no
 * `notification-center[data-open]` / `data-notification-open` element (the earlier
 * guess the driver + reader keyed off, which never matched, so an open sheet was
 * invisible to the loop).
 */
export const NOTIFICATION_OPEN_SELECTOR =
  '[data-testid="notification-sheet"][data-open], [data-testid="notification-panel"][data-open]';

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
  readonly notificationOpen: boolean;
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
  /** Downward pull on the notification zone; `committed` crosses the reveal
   *  threshold (open) or not (retract). */
  notificationPull(committed: boolean): Promise<void>;
  /** Dismiss an open notification center. */
  dismissNotification(): Promise<void>;
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
  readonly notificationOpen: string;
}

const READER_SELECTORS: ReaderSelectors = {
  surface: LAUNCHER_SELECTORS.surface,
  rail: LAUNCHER_SELECTORS.rail,
  pageProbe: LAUNCHER_SELECTORS.pageProbe,
  homePage: LAUNCHER_SELECTORS.homePage,
  launcherPage: LAUNCHER_SELECTORS.launcherPage,
  notificationOpen: NOTIFICATION_OPEN_SELECTOR,
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
  const notification = !!document.querySelector(sel.notificationOpen);
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
    notificationOpen: notification,
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
  /** px for a committed notification pull (clears the reveal threshold). */
  readonly pullDistance?: number;
  /** px for a rejected notification pull. */
  readonly pullRejectDistance?: number;
}

/**
 * Web / desktop-renderer driver. Realizes gestures with trusted CDP touch and
 * mouse; reads observations from the live DOM + telemetry ring. Requires a
 * `hasTouch: true` context for the touch gestures to be accepted.
 */
export class CdpTouchDriver implements Driver {
  private readonly commitDistance: number;
  private readonly rejectDistance: number;
  private readonly pullDistance: number;
  private readonly pullRejectDistance: number;

  constructor(
    private readonly page: Page,
    options: CdpTouchDriverOptions = {},
  ) {
    // 280 px comfortably clears the pager's DISTANCE_THRESHOLD_RATIO (0.5 of the
    // ~402 px page → ~201 px commit line); 220 sat close enough that a coalesced
    // touch burst could land just under it.
    this.commitDistance = options.commitDistance ?? 280;
    this.rejectDistance = options.rejectDistance ?? 24;
    this.pullDistance = options.pullDistance ?? 140;
    this.pullRejectDistance = options.pullRejectDistance ?? 20;
  }

  async railSwipe(
    direction: "left" | "right",
    committed: boolean,
  ): Promise<void> {
    // The model treats a committed rail swipe as navigating AND closing any open
    // notification center (advanceModel → commitPage). A real open notification is
    // a modal overlay (backdrop + sheet, pointer-events auto) that intercepts the
    // touch, so the swipe never reaches the rail and it stays parked — a
    // model-vs-reality divergence. Dismiss it first so the swipe lands on the rail
    // and the net state matches the model.
    if (await this.notificationIsOpen()) await this.dismissNotification();

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
    const magnitude = committed ? this.commitDistance : this.rejectDistance;
    const dx = direction === "left" ? -magnitude : magnitude;

    // 16 ms/step (the proven run-home-screen-e2e cadence) keeps the touchMove
    // burst on separate frames so the pager's velocity tracker sees real motion;
    // at 2 ms/step Chromium coalesces the burst into one composited jump and the
    // flick is dropped. A CDP touch can still be dropped by the compositor under
    // load (a delivery artifact no finger reproduces), so a committing swipe that
    // fails to land is re-dispatched, bounded. A reject (expected === before)
    // matches on the first pass and never retries; a genuine model/driver
    // divergence lands on the wrong page and is caught by the invariant check.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await touchSwipe(this.page, target, dx, 0, {
        steps: 10,
        stepDelayMs: 16,
      });
      await this.settle();
      if ((await this.readDataPage()) === expected) return;
    }
  }

  async railEdgeButton(direction: "prev" | "next"): Promise<void> {
    const selector =
      direction === "prev"
        ? LAUNCHER_SELECTORS.railPrevButton
        : LAUNCHER_SELECTORS.railNextButton;
    const button = this.page.locator(selector).first();
    if ((await button.count()) > 0 && (await button.isVisible())) {
      await button.click();
      await this.settle();
      return;
    }
    // Coarse-pointer (touch) surfaces don't render the edge chevrons —
    // `PagerEdgeButtons` is fine-pointer-only — so the same navigation intent is a
    // committed rail flick (next = home→launcher = left; prev = launcher→home =
    // right). Keeps the driver faithful to the abstract "go to that page" action
    // the model advances regardless of which affordance realizes it.
    await this.railSwipe(direction === "next" ? "left" : "right", true);
  }

  async tapTile(tileId: string): Promise<void> {
    // The launcher grid (`launcher-page-window`) is `overflow-y-auto`; a prior
    // gridScroll can push a tile off-window, where a center-tap resolves to
    // `elementFromPoint(...) === null` and launches nothing (the model still
    // expects a launch → launchCount diverges). A real user scrolls the tile into
    // view before tapping it, so do the same.
    await this.page
      .locator(LAUNCHER_SELECTORS.tile(tileId))
      .first()
      .scrollIntoViewIfNeeded();
    await touchTap(this.page, LAUNCHER_SELECTORS.tile(tileId));
    await this.settle();
  }

  async longPressTile(tileId: string): Promise<void> {
    await this.page
      .locator(LAUNCHER_SELECTORS.tile(tileId))
      .first()
      .scrollIntoViewIfNeeded();
    await touchLongPress(this.page, LAUNCHER_SELECTORS.tile(tileId), 650);
    await this.settle();
  }

  private async readDataPage(): Promise<string | null> {
    return this.page
      .locator(LAUNCHER_SELECTORS.surface)
      .first()
      .getAttribute("data-page");
  }

  private async notificationIsOpen(): Promise<boolean> {
    return this.page.evaluate(
      (selector) => Boolean(document.querySelector(selector)),
      NOTIFICATION_OPEN_SELECTOR,
    );
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

  async notificationPull(committed: boolean): Promise<void> {
    const distance = committed ? this.pullDistance : this.pullRejectDistance;
    const drag = await touchDragHold(
      this.page,
      LAUNCHER_SELECTORS.notificationPullZone,
      0,
      distance,
      { steps: 10, stepDelayMs: committed ? 2 : 10 },
    );
    await drag.release();
    await this.settle();
  }

  async dismissNotification(): Promise<void> {
    await this.page.keyboard.press("Escape");
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
    // Wait for the rail to actually REST before the caller observes it: every rail
    // animation finished AND the transform parked at a page boundary (0 or a whole
    // -width multiple). A bare double-rAF returns mid-commit under load — the
    // observation then reads a transitioning rail and the transform/page invariant
    // sees `data-page` lagging the model (#12179). Page-agnostic, so it stays a
    // driver concern and does not duplicate the model's page tracking.
    await this.page
      .waitForFunction(
        () => {
          const rail = document.querySelector(
            '[data-testid="home-launcher-rail"]',
          );
          const surface = document.querySelector(
            '[data-testid="home-launcher-surface"]',
          );
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
        undefined,
        { timeout: 4000 },
      )
      // error-policy:J7 a rail that never rests is a real bug — swallow the raw
      // playwright timeout and let checkInvariants report it with model context
      // (transformX=… expected …) instead of an opaque waitForFunction error.
      .catch(() => undefined);
    await this.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  }
}
