// @vitest-environment jsdom

/**
 * MEASURED-GAP contract for the iOS standalone-PWA bottom reclaim (device r8).
 *
 * ── WHY THIS TEST EXISTS ──
 * The recurring home-indicator "bottom bar" survived FIVE CSS-only PRs
 * (#14067 … #14996), each pinning the reclaim to `max(0px, 100lvh - 100dvh)`
 * and each guarded by a test that only re-asserted that STRING was present in
 * the source. On the real device the fixed-body ICB collapses so the CSS length
 * engine resolves BOTH `lvh` and `dvh` against the same collapsed box, making
 * `100lvh - 100dvh === 0` — every reclaim a no-op, the strip untouched, the
 * tests still green. A string test can never catch that.
 *
 * #15036 then bet that `innerHeight` / `visualViewport.height` still see the
 * true screen while only `documentElement.clientHeight` collapses. On-device
 * diagnostics (`ih873 vv873 ce873 sh932 rc0 lv932 dv873`) proved that ALSO
 * dead: innerHeight, visualViewport.height, AND clientHeight ALL collapse to
 * 873, so `max(vv,inner) - clientHeight = 0`, a SIXTH no-op. The ONLY value
 * that still sees the true 932px screen is `window.screen.height`.
 *
 * These tests pin the DEFINITIVE measurement: the true physical height is
 * `screen.height` (932), the collapsed layout box is `documentElement
 * .clientHeight` (873), and the real gap is `screen.height - clientHeight` = 59.
 * They stub the FULL collapsed geometry (innerHeight == vv == clientHeight ==
 * 873, screen.height == 932) exactly as the device reports it, so the #15036
 * code path would produce 0 here, that is the failing case this green test now
 * covers.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  applyStandaloneBottomReclaim,
  clearStandaloneBottomReclaim,
  installStandaloneBottomReclaim,
  measureStandaloneBottomGap,
  STANDALONE_BOTTOM_RECLAIM_OFFSET,
  STANDALONE_BOTTOM_RECLAIM_VAR,
  shouldInstallStandaloneBottomReclaim,
} from "./standalone-bottom-reclaim";

/**
 * Reproduce the collapsed fixed-body geometry EXACTLY as the device reports it:
 *  - `documentElement.clientHeight` = the LAYOUT (small/collapsed) viewport (873).
 *  - `window.screen.height` = the TRUE physical screen height (932), the ONLY
 *    value that survives the ICB collapse.
 *  - `window.innerHeight` / `visualViewport.height` ALSO collapse to the layout
 *    box on device; they default to `layoutHeight` here to mirror that (proving
 *    the measurement no longer depends on them). Override only to model a
 *    non-collapsed surface.
 * The real bottom gap is `screen.height - layoutHeight`.
 */
function stubViewport(opts: {
  layoutHeight: number;
  screenHeight?: number;
  innerHeight?: number;
  visualHeight?: number;
  visualOffsetTop?: number;
}): void {
  Object.defineProperty(document.documentElement, "clientHeight", {
    configurable: true,
    get: () => opts.layoutHeight,
  });
  // On device innerHeight/visualViewport collapse to the layout box too; mirror
  // that by defaulting them to layoutHeight (the measurement must NOT read them).
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: opts.innerHeight ?? opts.layoutHeight,
  });
  Object.defineProperty(window, "screen", {
    configurable: true,
    writable: true,
    value: { height: opts.screenHeight ?? opts.layoutHeight },
  });
  const visualHeight = opts.visualHeight ?? opts.layoutHeight;
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    writable: true,
    value: {
      height: visualHeight,
      offsetTop: opts.visualOffsetTop ?? 0,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
}

afterEach(() => {
  document.documentElement.style.removeProperty(STANDALONE_BOTTOM_RECLAIM_VAR);
  // Restore a benign viewport so cases don't bleed.
  Object.defineProperty(document.documentElement, "clientHeight", {
    configurable: true,
    get: () => 0,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: 0,
  });
  Object.defineProperty(window, "screen", {
    configurable: true,
    writable: true,
    value: { height: 0 },
  });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

describe("measureStandaloneBottomGap: the screen.height cure for the collapsed-ICB strip", () => {
  it("measures the 59px gap when innerHeight is still collapsed (pre-html-fix / any engine that collapses the fixed-layer viewport)", () => {
    // If a shell collapses innerHeight to the layout box (873) while
    // screen.height still sees 932, the fixed layers stop 59px short and we DO
    // reclaim: gap = screen.height - innerHeight = 932 - 873 = 59.
    stubViewport({
      layoutHeight: 873,
      innerHeight: 873,
      visualHeight: 873,
      screenHeight: 932,
    });
    expect(measureStandaloneBottomGap()).toBe(59);
  });

  it("is 0 once html:100lvh un-collapses innerHeight to the true screen (the r11 over-correction fix)", () => {
    // r11: sizing `html` to 100lvh un-collapses the viewport — the device chip
    // flipped to ih932 vv932 dv932 while ONLY clientHeight stayed 873. Now the
    // fixed layers already reach the true 932 bottom, so the reclaim MUST be 0
    // (measuring vs clientHeight would give a phantom 59 and shove the composer
    // 59px off-screen — the over-correction). We measure vs innerHeight (932),
    // NOT clientHeight (873): 932 - 932 = 0.
    stubViewport({
      layoutHeight: 873, // documentElement.clientHeight still collapsed
      innerHeight: 932, // html:100lvh made innerHeight truthful
      visualHeight: 932,
      screenHeight: 932,
    });
    expect(measureStandaloneBottomGap()).toBe(0);
  });

  it("is EXACTLY 0 on desktop/Android/web where screen.height == the layout box (no-op)", () => {
    // No fixed-body ICB collapse: screen.height agrees with clientHeight → the
    // reclaim must be a true no-op, NOT a guess. Regression guard against
    // shifting web/desktop layers.
    stubViewport({
      layoutHeight: 900,
      innerHeight: 900,
      visualHeight: 900,
      screenHeight: 900,
    });
    expect(measureStandaloneBottomGap()).toBe(0);
  });

  it("is 0 (never negative) when the layout box exceeds screen.height (defensive)", () => {
    // Should not happen physically, but a layout box taller than the physical
    // screen must reclaim nothing, never a negative translate off-screen.
    stubViewport({
      layoutHeight: 1000,
      screenHeight: 900,
    });
    expect(measureStandaloneBottomGap()).toBe(0);
  });

  it("returns 0 when screen.height is unavailable (SSR / ancient engine)", () => {
    // No usable screen.height → no measurement, no reclaim, no harm.
    stubViewport({ layoutHeight: 873, screenHeight: 0 });
    expect(measureStandaloneBottomGap()).toBe(0);
  });

  it("clamps an absurd transient delta (mid-rotation) to a sane upper bound", () => {
    stubViewport({ layoutHeight: 300, screenHeight: 2000 });
    expect(measureStandaloneBottomGap()).toBe(160);
  });
});

describe("applyStandaloneBottomReclaim — writes the MEASURED gap to the CSS var", () => {
  it("writes the measured 59px gap to --standalone-bottom-reclaim (would be 0 under #15036's inputs)", () => {
    // The DEFINITIVE assertion: device inputs (ce873 sh932), var flips to 59px
    // where #15036's max(inner,vv)-clientHeight would have written 0px.
    stubViewport({
      layoutHeight: 873,
      innerHeight: 873,
      visualHeight: 873,
      screenHeight: 932,
    });
    const written = applyStandaloneBottomReclaim();
    expect(written).toBe(59);
    expect(
      document.documentElement.style.getPropertyValue(
        STANDALONE_BOTTOM_RECLAIM_VAR,
      ),
    ).toBe("59px");
  });

  it("writes 0px on the non-collapsed (web/desktop/Android) geometry", () => {
    stubViewport({
      layoutHeight: 900,
      innerHeight: 900,
      visualHeight: 900,
      screenHeight: 900,
    });
    applyStandaloneBottomReclaim();
    expect(
      document.documentElement.style.getPropertyValue(
        STANDALONE_BOTTOM_RECLAIM_VAR,
      ),
    ).toBe("0px");
  });
});

describe("clearStandaloneBottomReclaim — hard 0 on non-standalone surfaces", () => {
  it("forces the var to 0px so the shared reclaim calc is a true no-op", () => {
    document.documentElement.style.setProperty(
      STANDALONE_BOTTOM_RECLAIM_VAR,
      "59px",
    );
    clearStandaloneBottomReclaim();
    expect(
      document.documentElement.style.getPropertyValue(
        STANDALONE_BOTTOM_RECLAIM_VAR,
      ),
    ).toBe("0px");
  });
});

describe("shouldInstallStandaloneBottomReclaim — platform gate", () => {
  it("installs for standalone PWAs and iOS native WebViews only", () => {
    expect(
      shouldInstallStandaloneBottomReclaim({
        standalonePwa: true,
        isNative: false,
        isIOS: false,
      }),
    ).toBe(true);
    expect(
      shouldInstallStandaloneBottomReclaim({
        standalonePwa: false,
        isNative: true,
        isIOS: true,
      }),
    ).toBe(true);
  });

  it("does not install listeners on Android native, desktop, or browser tabs", () => {
    expect(
      shouldInstallStandaloneBottomReclaim({
        standalonePwa: false,
        isNative: true,
        isIOS: false,
      }),
    ).toBe(false);
    expect(
      shouldInstallStandaloneBottomReclaim({
        standalonePwa: false,
        isNative: false,
        isIOS: false,
      }),
    ).toBe(false);
  });
});

describe("installStandaloneBottomReclaim — idempotent, no duplicate listeners", () => {
  it("primes the var immediately and disposes the prior install on re-install", () => {
    stubViewport({
      layoutHeight: 873,
      innerHeight: 873,
      visualHeight: 873,
      screenHeight: 932,
    });

    const added: string[] = [];
    const removed: string[] = [];
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (origAdd as unknown as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (origRemove as unknown as (...a: unknown[]) => void)(
        type,
        ...rest,
      );
    }) as typeof window.removeEventListener;

    try {
      const dispose1 = installStandaloneBottomReclaim();
      // Primed synchronously on install (first paint has the right reclaim).
      expect(
        document.documentElement.style.getPropertyValue(
          STANDALONE_BOTTOM_RECLAIM_VAR,
        ),
      ).toBe("59px");
      const addedAfterFirst = added.filter((t) => t === "resize").length;

      // Re-install: must dispose the first (remove its resize listener) before
      // arming again — net window resize listeners stays at 1, not 2.
      const dispose2 = installStandaloneBottomReclaim();
      expect(removed).toContain("resize");
      expect(added.filter((t) => t === "resize").length).toBe(
        addedAfterFirst + 1,
      );

      dispose2();
      // First disposer is a no-op now (already superseded) — safe to call.
      dispose1();
    } finally {
      window.addEventListener = origAdd;
      window.removeEventListener = origRemove;
      clearStandaloneBottomReclaim();
    }
  });

  it("clearStandaloneBottomReclaim tears down an active install and zeroes the var", () => {
    stubViewport({
      layoutHeight: 873,
      innerHeight: 873,
      visualHeight: 873,
      screenHeight: 932,
    });
    installStandaloneBottomReclaim();
    clearStandaloneBottomReclaim();
    expect(
      document.documentElement.style.getPropertyValue(
        STANDALONE_BOTTOM_RECLAIM_VAR,
      ),
    ).toBe("0px");
  });
});

describe("the shared reclaim offset references the MEASURED var, not lvh/dvh", () => {
  it("is calc(-1 * var(--standalone-bottom-reclaim, 0px)) — no CSS-unit calc", () => {
    // The offset the layers apply MUST resolve to the measured gap; when the var
    // is 0 (web/desktop/Android) it is calc(-1 * 0px) === 0, a true no-op.
    expect(STANDALONE_BOTTOM_RECLAIM_OFFSET).toBe(
      "calc(-1 * var(--standalone-bottom-reclaim, 0px))",
    );
    expect(STANDALONE_BOTTOM_RECLAIM_OFFSET).not.toContain("100lvh");
    expect(STANDALONE_BOTTOM_RECLAIM_OFFSET).not.toContain("100dvh");
  });
});
