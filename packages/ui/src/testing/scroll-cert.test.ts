// @vitest-environment node
//
// Unit coverage for the PURE scroll + tap-target certification verdict math
// (#14380). Each dimension is proven both ways: the detector fires (RED) on a
// violating measurement and stays silent (GREEN) on a compliant one — so the
// certification itself is trustworthy before it is pointed at any live widget.

import { describe, expect, it } from "vitest";

import {
  buildWidgetReport,
  certifyAnchorPreserved,
  certifyKeyboardClearance,
  certifyOverscrollContained,
  certifySafeAreaClearance,
  certifyScrollGeometry,
  certifyTapTarget,
  certifyTapTargets,
  MAX_ANCHOR_JUMP_PX,
  MIN_TAP_TARGET_PX,
  renderRunSummary,
  type ScrollerGeometry,
  summarizeRun,
} from "./scroll-cert";

/* ── 1. scroll geometry ─────────────────────────────────────────────────── */

const goodScroller: ScrollerGeometry = {
  scrollHeight: 2000,
  clientHeight: 800,
  scrollWidth: 400,
  clientWidth: 400,
  overflowY: "auto",
  overflowX: "hidden",
  midScrollTopSettled: 600,
  overscrollBehaviorY: "contain",
};

describe("certifyScrollGeometry", () => {
  it("passes a bounded overflow scroller that accepts a mid scrollTop", () => {
    expect(certifyScrollGeometry(goodScroller)).toEqual([]);
  });

  it("ignores a scroller whose content fits (nothing to scroll)", () => {
    expect(
      certifyScrollGeometry({
        ...goodScroller,
        scrollHeight: 800,
        clientHeight: 800,
        overflowY: "visible",
        midScrollTopSettled: 0,
      }),
    ).toEqual([]);
  });

  it("FAILS when content overflows but overflow-y is not scrollable", () => {
    const v = certifyScrollGeometry({ ...goodScroller, overflowY: "visible" });
    expect(v.map((x) => x.code)).toContain("scroll/overflow-not-scrollable");
  });

  it("FAILS the height-chain when a mid scrollTop clamps to 0 (can't-scroll bug)", () => {
    const v = certifyScrollGeometry({
      ...goodScroller,
      midScrollTopSettled: 0,
    });
    expect(v.map((x) => x.code)).toContain("scroll/height-chain-collapsed");
  });

  it("FAILS on unintended horizontal overflow", () => {
    const v = certifyScrollGeometry(
      {
        ...goodScroller,
        scrollWidth: 520,
        clientWidth: 400,
        overflowX: "hidden",
      },
      "#continuous-thread",
    );
    const h = v.find((x) => x.code === "scroll/horizontal-overflow");
    expect(h).toBeTruthy();
    expect(h?.target).toBe("#continuous-thread");
  });

  it("allows horizontal overflow when overflow-x is an explicit opt-in", () => {
    const v = certifyScrollGeometry({
      ...goodScroller,
      scrollWidth: 520,
      clientWidth: 400,
      overflowX: "auto",
    });
    expect(v.map((x) => x.code)).not.toContain("scroll/horizontal-overflow");
  });
});

/* ── anchor preservation ────────────────────────────────────────────────── */

describe("certifyAnchorPreserved", () => {
  it("passes when the anchor stays put across a prepend", () => {
    expect(
      certifyAnchorPreserved({
        anchorOffsetBefore: 120,
        anchorOffsetAfter: 121,
        kind: "prepend",
      }),
    ).toEqual([]);
  });

  it("FAILS when a prepend yanks the reader down by the grown height", () => {
    const v = certifyAnchorPreserved({
      anchorOffsetBefore: 120,
      anchorOffsetAfter: 620,
      kind: "prepend",
    });
    expect(v).toHaveLength(1);
    expect(v[0].code).toBe("scroll/anchor-jump-on-prepend");
    expect(v[0].message).toContain("500.0px");
  });

  it("tolerates sub-pixel rounding at the cap boundary", () => {
    expect(
      certifyAnchorPreserved({
        anchorOffsetBefore: 0,
        anchorOffsetAfter: MAX_ANCHOR_JUMP_PX,
        kind: "append",
      }),
    ).toEqual([]);
  });
});

/* ── overscroll containment ─────────────────────────────────────────────── */

describe("certifyOverscrollContained", () => {
  it("exempts a root (non-nested) scroller", () => {
    expect(
      certifyOverscrollContained(
        { overscrollBehaviorY: "auto" },
        { nestedInScroller: false },
      ),
    ).toEqual([]);
  });

  it("passes a nested scroller that contains its overscroll", () => {
    expect(
      certifyOverscrollContained(
        { overscrollBehaviorY: "contain" },
        { nestedInScroller: true },
      ),
    ).toEqual([]);
  });

  it("FAILS a nested scroller that chains overscroll to an ancestor", () => {
    const v = certifyOverscrollContained(
      { overscrollBehaviorY: "auto" },
      { nestedInScroller: true },
      "conversations-sidebar",
    );
    expect(v).toHaveLength(1);
    expect(v[0].code).toBe("scroll/overscroll-chains");
    expect(v[0].target).toBe("conversations-sidebar");
  });

  it("treats a missing overscroll-behavior as the chaining default", () => {
    const v = certifyOverscrollContained({}, { nestedInScroller: true });
    expect(v.map((x) => x.code)).toContain("scroll/overscroll-chains");
  });
});

/* ── 2. keyboard clearance ──────────────────────────────────────────────── */

describe("certifyKeyboardClearance", () => {
  it("passes when the composer stays above the keyboard fold", () => {
    expect(
      certifyKeyboardClearance({
        layoutViewportHeight: 874,
        visualViewportHeight: 500,
        interactiveTop: 440,
        interactiveBottom: 496,
      }),
    ).toEqual([]);
  });

  it("no-ops when the keyboard is down (visual == layout)", () => {
    expect(
      certifyKeyboardClearance({
        layoutViewportHeight: 874,
        visualViewportHeight: 874,
        interactiveTop: 900,
        interactiveBottom: 980,
      }),
    ).toEqual([]);
  });

  it("FAILS when the interactive region is fully behind the keyboard", () => {
    const v = certifyKeyboardClearance({
      layoutViewportHeight: 874,
      visualViewportHeight: 500,
      interactiveTop: 520,
      interactiveBottom: 576,
    });
    expect(v[0].code).toBe("keyboard/region-fully-hidden");
  });

  it("FAILS when the interactive region is partially clipped by the keyboard", () => {
    const v = certifyKeyboardClearance({
      layoutViewportHeight: 874,
      visualViewportHeight: 500,
      interactiveTop: 470,
      interactiveBottom: 540,
    });
    expect(v[0].code).toBe("keyboard/region-clipped");
  });
});

/* ── 3. safe-area clearance ─────────────────────────────────────────────── */

describe("certifySafeAreaClearance", () => {
  const base = {
    insetTop: 59,
    insetBottom: 34,
    viewportHeight: 874,
  };

  it("passes a control clear of both insets", () => {
    expect(
      certifySafeAreaClearance({
        ...base,
        controlTop: 70,
        controlBottom: 114,
      }),
    ).toEqual([]);
  });

  it("FAILS a control whose top sits under the notch", () => {
    const v = certifySafeAreaClearance({
      ...base,
      controlTop: 20,
      controlBottom: 64,
    });
    expect(v[0].code).toBe("safe-area/under-top-inset");
  });

  it("FAILS a control whose bottom sits under the home indicator", () => {
    const v = certifySafeAreaClearance({
      ...base,
      controlTop: 800,
      controlBottom: 860,
    });
    expect(v[0].code).toBe("safe-area/under-bottom-inset");
  });
});

/* ── 4. tap targets ─────────────────────────────────────────────────────── */

describe("certifyTapTarget", () => {
  it("passes a 44x44 control", () => {
    expect(certifyTapTarget({ width: 44, height: 44, target: "send" })).toEqual(
      [],
    );
  });

  it(`FAILS a control below ${MIN_TAP_TARGET_PX}px on either axis`, () => {
    expect(
      certifyTapTarget({ width: 44, height: 28, target: "close-x" }),
    ).toHaveLength(1);
    expect(
      certifyTapTarget({ width: 30, height: 44, target: "chevron" }),
    ).toHaveLength(1);
  });

  it("uses the effective (expanded) hit box when provided", () => {
    // A 24px glyph with a 44px padded hit area passes.
    expect(
      certifyTapTarget({
        width: 24,
        height: 24,
        effectiveWidth: 44,
        effectiveHeight: 48,
        target: "icon-btn",
      }),
    ).toEqual([]);
  });

  it("sweeps a set and collects every undersized control", () => {
    const v = certifyTapTargets([
      { width: 44, height: 44, target: "ok" },
      { width: 20, height: 20, target: "tiny-a" },
      { width: 44, height: 30, target: "short-b" },
    ]);
    expect(v).toHaveLength(2);
    expect(v.map((x) => x.target)).toEqual(["tiny-a", "short-b"]);
  });
});

/* ── report assembly ────────────────────────────────────────────────────── */

describe("report assembly", () => {
  it("marks a widget passed when it has no violations", () => {
    const r = buildWidgetReport("demo-buttons", ["tap-target"], []);
    expect(r.passed).toBe(true);
  });

  it("marks a widget failed and carries its violations", () => {
    const viol = certifyTapTarget({ width: 20, height: 20, target: "x" });
    const r = buildWidgetReport("demo-buttons", ["tap-target"], viol);
    expect(r.passed).toBe(false);
    expect(r.violations).toEqual(viol);
  });

  it("summarizes a run and renders an actionable text block", () => {
    const pass = buildWidgetReport("transcript", ["scroll"], []);
    const fail = buildWidgetReport(
      "demo-buttons",
      ["tap-target"],
      certifyTapTarget({ width: 30, height: 30, target: "swatch-3" }),
    );
    const run = summarizeRun([pass, fail]);
    expect(run.passed).toBe(false);
    expect(run.total).toBe(2);
    expect(run.failed).toBe(1);

    const text = renderRunSummary(run);
    expect(text).toContain("FAIL");
    expect(text).toContain("\u2713 transcript");
    expect(text).toContain("\u2717 demo-buttons");
    expect(text).toContain("swatch-3");
    expect(text).toContain("tap-target/below-minimum");
  });
});
