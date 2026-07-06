// @vitest-environment jsdom

/**
 * MEASURED-GAP contract for the iOS standalone-PWA bottom reclaim (device r6).
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
 * These tests instead pin the MEASURED gap: they reproduce the collapsed
 * geometry (true screen height via window.innerHeight / visualViewport, the
 * collapsed layout box via documentElement.clientHeight) and assert
 * `measureStandaloneBottomGap()` / the applied `--standalone-bottom-reclaim`
 * var equals the REAL delta. The pre-fix code path (CSS-unit calc) would have
 * produced a 0 reclaim in this exact geometry — that is the failing case this
 * green test now covers.
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
 * Reproduce the collapsed fixed-body geometry:
 *  - `documentElement.clientHeight` = the LAYOUT (small/collapsed) viewport.
 *  - `window.innerHeight` = the TRUE (large) screen height.
 *  - `window.visualViewport.height` = the TRUE visible height (optional).
 * The real bottom gap is `trueHeight - layoutHeight`.
 */
function stubViewport(opts: {
  layoutHeight: number;
  innerHeight: number;
  visualHeight?: number;
  visualOffsetTop?: number;
}): void {
  Object.defineProperty(document.documentElement, "clientHeight", {
    configurable: true,
    get: () => opts.layoutHeight,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: opts.innerHeight,
  });
  if (opts.visualHeight !== undefined) {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      writable: true,
      value: {
        height: opts.visualHeight,
        offsetTop: opts.visualOffsetTop ?? 0,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
  } else {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      writable: true,
      value: undefined,
    });
  }
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
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

describe("measureStandaloneBottomGap — the JS cure for the collapsed-ICB strip", () => {
  it("measures the ~59px gap on the collapsed iOS-standalone geometry (the exact bug)", () => {
    // Home-indicator iPhone standalone: layout ICB collapsed to 873, true
    // screen 932 → the 59px strip the CSS-unit calc could NOT see.
    stubViewport({ layoutHeight: 873, innerHeight: 932, visualHeight: 932 });
    expect(measureStandaloneBottomGap()).toBe(59);
  });

  it("prefers the visualViewport height and adds back a scrolled offsetTop", () => {
    // visualViewport shifted up (rubber-band / partial keyboard): height 900 +
    // offsetTop 32 = 932 true; innerHeight smaller → we take the VV composite.
    stubViewport({
      layoutHeight: 873,
      innerHeight: 900,
      visualHeight: 900,
      visualOffsetTop: 32,
    });
    expect(measureStandaloneBottomGap()).toBe(59);
  });

  it("is EXACTLY 0 on desktop/Android/web where layout == true height (no-op)", () => {
    // The two viewports agree → the reclaim must be a true no-op, NOT a guess.
    // This is the regression guard against shifting web/desktop layers.
    stubViewport({ layoutHeight: 900, innerHeight: 900, visualHeight: 900 });
    expect(measureStandaloneBottomGap()).toBe(0);
  });

  it("is 0 (never negative) when the keyboard shrinks the visual viewport below the layout box", () => {
    // Keyboard up: visualViewport collapses well under the layout ICB. The
    // resting reclaim must be 0 here (the composer's keyboard-lift path owns
    // that case) — never a negative translate that would pull layers off-screen.
    stubViewport({
      layoutHeight: 873,
      innerHeight: 500,
      visualHeight: 500,
    });
    expect(measureStandaloneBottomGap()).toBe(0);
  });

  it("clamps an absurd transient delta (mid-rotation) to a sane upper bound", () => {
    stubViewport({ layoutHeight: 300, innerHeight: 2000, visualHeight: 2000 });
    expect(measureStandaloneBottomGap()).toBe(160);
  });
});

describe("applyStandaloneBottomReclaim — writes the MEASURED gap to the CSS var", () => {
  it("writes the measured 59px gap to --standalone-bottom-reclaim (would be 0 under the old CSS-unit calc)", () => {
    stubViewport({ layoutHeight: 873, innerHeight: 932, visualHeight: 932 });
    const written = applyStandaloneBottomReclaim();
    expect(written).toBe(59);
    expect(
      document.documentElement.style.getPropertyValue(
        STANDALONE_BOTTOM_RECLAIM_VAR,
      ),
    ).toBe("59px");
  });

  it("writes 0px on the non-collapsed (web/desktop/Android) geometry", () => {
    stubViewport({ layoutHeight: 900, innerHeight: 900, visualHeight: 900 });
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
    stubViewport({ layoutHeight: 873, innerHeight: 932, visualHeight: 932 });

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
    stubViewport({ layoutHeight: 873, innerHeight: 932, visualHeight: 932 });
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
