/**
 * WIDGET CERTIFICATION HARNESS (#14380) — the DOM-walking layer that turns a
 * rendered widget into the measurements {@link ./scroll-cert.ts} judges.
 *
 * Two-layer design, same philosophy as the rest of `src/testing`:
 *
 *  • STATIC layer (jsdom / vitest, always runs): walk the rendered widget's DOM
 *    for interactive controls and scroll containers, read their boxes through a
 *    pluggable {@link GeometryProvider}, and run the pure verdicts. jsdom does
 *    not lay out, so the provider is where a test injects known geometry (the
 *    same technique `useLoadOlderOnScroll.test.tsx` uses to stub scrollHeight).
 *    A real browser can supply a provider backed by `getBoundingClientRect` +
 *    `getComputedStyle` so the SAME sweep runs live.
 *
 *  • DEEP layer (playwright, env-permitting): the browser harness in
 *    `__e2e__/run-widget-cert-e2e.mjs` mounts the widget in real Chromium/WebKit
 *    and provides a live provider, so anchor-jump / overscroll / keyboard checks
 *    exercise real layout + touch. Playwright is known-flaky in the fleet CI
 *    box; the static layer is the always-green gate, the deep layer is the
 *    proof when it can run.
 *
 * The sweep is deliberately conservative about what counts as an INTERACTIVE
 * control (so the tap-target floor isn't applied to decorative spans): native
 * button/a/input/select/textarea + `[role=button|link|tab|switch|menuitem|
 * checkbox|radio]` + `[tabindex]` >= 0 + anything with an explicit
 * `data-tap-target`. A control opts OUT with `data-tap-target="ignore"`
 * (documented escape hatch for genuinely non-pointer affordances).
 */

import {
  buildWidgetReport,
  certifyKeyboardClearance,
  certifyOverscrollContained,
  certifySafeAreaClearance,
  certifyScrollGeometry,
  certifyTapTargets,
  type KeyboardGeometry,
  type SafeAreaGeometry,
  type ScrollerGeometry,
  type TapTarget,
  type Violation,
  type WidgetCertReport,
} from "./scroll-cert";

export type { WidgetCertReport } from "./scroll-cert";

/** A measured box in the layout viewport (px). */
export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Supplies geometry + computed style for an element. In a real browser this is
 * `getBoundingClientRect` + `getComputedStyle`; under jsdom a test provides a
 * map so the DETECTOR is exercised on known-broken and known-good inputs.
 */
export interface GeometryProvider {
  box(el: Element): Box;
  computed(el: Element): {
    overflowY: string;
    overflowX: string;
    overscrollBehaviorY?: string;
  };
  /**
   * Optional effective (expanded) hit box for a control whose visual box is
   * smaller than its tappable area (padding / ::before / hitSlop). Returning
   * undefined falls back to the visual box.
   */
  effectiveHitBox?(el: Element): Box | undefined;
  /**
   * Optional: set scrollTop to ~scrollHeight/2 and return where it settled, so
   * the height-chain check works. Under jsdom the provider fakes this; a real
   * browser mutates the node. Defaults to reporting the element's scrollTop.
   */
  probeMidScrollTop?(el: Element): number;
}

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type=hidden])",
  "select",
  "textarea",
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  "[tabindex]",
  "[data-tap-target]",
].join(",");

const SCROLLER_SELECTOR = [
  "[data-scroll-cert-scroller]",
  '[data-testid="chat-thread"]',
  "#continuous-thread",
].join(",");

/** Best-effort human locator for a control, for the per-widget report. */
export function locate(el: Element): string {
  const testid = el.getAttribute("data-testid");
  if (testid) return `[data-testid="${testid}"]`;
  const tap = el.getAttribute("data-tap-target");
  if (tap && tap !== "ignore") return `[data-tap-target="${tap}"]`;
  const aria = el.getAttribute("aria-label");
  if (aria) return `${el.tagName.toLowerCase()}[aria-label="${aria}"]`;
  const id = el.id;
  if (id) return `#${id}`;
  const text = (el.textContent ?? "").trim().slice(0, 24);
  return `${el.tagName.toLowerCase()}${text ? `:"${text}"` : ""}`;
}

/** Collect the interactive controls inside a root that opt into the tap floor. */
export function collectInteractive(root: Element): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR))) {
    if (el.getAttribute("data-tap-target") === "ignore") continue;
    // A disabled/aria-hidden control is not a live tap target.
    if (el.hasAttribute("disabled")) continue;
    if (el.getAttribute("aria-hidden") === "true") continue;
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && Number(tabindex) < 0) continue;
    out.push(el);
  }
  return out;
}

/** Collect scroll containers inside a root. */
export function collectScrollers(root: Element): Element[] {
  const found = Array.from(root.querySelectorAll(SCROLLER_SELECTOR));
  // Include the root itself if it opted in.
  if (root.matches?.(SCROLLER_SELECTOR)) found.unshift(root);
  return found;
}

/** Which dimensions to exercise for a given widget certification. */
export interface CertifyOptions {
  dimensions?: Violation["dimension"][];
  /** Safe-area insets in effect (px); required for the safe-area dimension. */
  safeArea?: { insetTop: number; insetBottom: number; viewportHeight: number };
  /** Keyboard geometry per interactive region; required for the keyboard dim. */
  keyboard?: KeyboardGeometry;
  /**
   * For each scroller, whether it is nested inside another scroller (so
   * overscroll containment is required). Keyed by the scroller's `locate()`.
   */
  nestedScrollers?: Record<string, boolean>;
  /** Optional evidence artifact paths to attach to the report. */
  artifacts?: string[];
}

const DEFAULT_DIMENSIONS: Violation["dimension"][] = [
  "scroll",
  "tap-target",
  "safe-area",
];

/**
 * Certify a rendered widget: sweep its DOM, read geometry through the provider,
 * run the pure verdicts, and assemble a per-widget report. This is the single
 * entry point both the jsdom tests and the playwright deep layer call.
 */
export function certifyWidget(
  widgetName: string,
  root: Element,
  provider: GeometryProvider,
  opts: CertifyOptions = {},
): WidgetCertReport {
  const dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS;
  const violations: Violation[] = [];

  // ── tap-target sweep ──────────────────────────────────────────────────
  if (dimensions.includes("tap-target")) {
    const controls = collectInteractive(root);
    const targets: TapTarget[] = controls.map((el) => {
      const box = provider.box(el);
      const eff = provider.effectiveHitBox?.(el);
      return {
        width: box.width,
        height: box.height,
        target: locate(el),
        ...(eff
          ? { effectiveWidth: eff.width, effectiveHeight: eff.height }
          : {}),
      };
    });
    violations.push(...certifyTapTargets(targets));
  }

  // ── safe-area sweep (interactive controls only) ───────────────────────
  if (dimensions.includes("safe-area") && opts.safeArea) {
    const controls = collectInteractive(root);
    for (const el of controls) {
      const box = provider.box(el);
      const s: SafeAreaGeometry = {
        insetTop: opts.safeArea.insetTop,
        insetBottom: opts.safeArea.insetBottom,
        viewportHeight: opts.safeArea.viewportHeight,
        controlTop: box.top,
        controlBottom: box.top + box.height,
      };
      violations.push(...certifySafeAreaClearance(s, locate(el)));
    }
  }

  // ── scroll sweep ──────────────────────────────────────────────────────
  if (dimensions.includes("scroll")) {
    for (const el of collectScrollers(root)) {
      const box = provider.box(el);
      const cs = provider.computed(el);
      const geo: ScrollerGeometry = {
        scrollHeight: el.scrollHeight,
        clientHeight: box.height,
        scrollWidth: el.scrollWidth,
        clientWidth: box.width,
        overflowY: cs.overflowY,
        overflowX: cs.overflowX,
        overscrollBehaviorY: cs.overscrollBehaviorY,
        midScrollTopSettled: provider.probeMidScrollTop
          ? provider.probeMidScrollTop(el)
          : el.scrollTop,
      };
      const loc = locate(el);
      violations.push(...certifyScrollGeometry(geo, loc));
      const nested = opts.nestedScrollers?.[loc] ?? false;
      violations.push(
        ...certifyOverscrollContained(
          { overscrollBehaviorY: cs.overscrollBehaviorY },
          { nestedInScroller: nested },
          loc,
        ),
      );
    }
  }

  // ── keyboard clearance ────────────────────────────────────────────────
  if (dimensions.includes("keyboard") && opts.keyboard) {
    violations.push(...certifyKeyboardClearance(opts.keyboard, widgetName));
  }

  return buildWidgetReport(widgetName, dimensions, violations, opts.artifacts);
}

/**
 * A jsdom-friendly {@link GeometryProvider} backed by an explicit element→box
 * map — the technique the hooks tests use to give jsdom (which never lays out)
 * real geometry. Elements not in the map report a zero box (so an unmeasured
 * control is a loud, catchable failure rather than a silent pass).
 */
export function mapGeometryProvider(
  entries: Iterable<
    [
      Element,
      {
        box: Box;
        overflowY?: string;
        overflowX?: string;
        overscrollBehaviorY?: string;
        scrollHeight?: number;
        scrollWidth?: number;
        midScrollTopSettled?: number;
        effectiveHitBox?: Box;
      },
    ]
  >,
): GeometryProvider {
  const map = new Map(entries);
  return {
    box(el) {
      return map.get(el)?.box ?? { top: 0, left: 0, width: 0, height: 0 };
    },
    computed(el) {
      const e = map.get(el);
      return {
        overflowY: e?.overflowY ?? "visible",
        overflowX: e?.overflowX ?? "visible",
        overscrollBehaviorY: e?.overscrollBehaviorY,
      };
    },
    effectiveHitBox(el) {
      return map.get(el)?.effectiveHitBox;
    },
    probeMidScrollTop(el) {
      return map.get(el)?.midScrollTopSettled ?? 0;
    },
  };
}

/**
 * A live-browser {@link GeometryProvider} backed by `getBoundingClientRect` +
 * `getComputedStyle`. Used by the playwright deep layer (and any real-DOM
 * test). `probeMidScrollTop` actually mutates the node — only safe in a
 * laying-out environment.
 */
export function liveGeometryProvider(win: Window): GeometryProvider {
  return {
    box(el) {
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height };
    },
    computed(el) {
      const cs = win.getComputedStyle(el);
      return {
        overflowY: cs.overflowY,
        overflowX: cs.overflowX,
        overscrollBehaviorY:
          cs.getPropertyValue("overscroll-behavior-y") || undefined,
      };
    },
    probeMidScrollTop(el) {
      el.scrollTop = Math.round(el.scrollHeight / 2);
      return el.scrollTop;
    },
  };
}
