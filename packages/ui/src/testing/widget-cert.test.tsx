// @vitest-environment jsdom
//
// biome-ignore-all lint/a11y/useButtonType: test fixtures deliberately construct edge-case DOM to exercise the interactive-control sweep
// biome-ignore-all lint/a11y/useSemanticElements: test fixtures deliberately use role=button spans to exercise the sweep selector
// biome-ignore-all lint/a11y/useFocusableInteractive: intentional non-focusable role=button edge case for the sweep
// biome-ignore-all lint/a11y/noNoninteractiveTabindex: intentional tabindex div edge case for the sweep
//
// Certifies the WIDGET-CERT harness (#14380) end-to-end against real rendered
// DOM: the sweep finds the interactive controls + scrollers, reads geometry
// through a provider, and the pure verdicts produce an actionable per-widget
// report. jsdom does not lay out, so geometry is injected through
// `mapGeometryProvider` (the same technique `useLoadOlderOnScroll.test.tsx`
// uses to give jsdom real scrollHeight) — the harness logic (which elements
// count, how the report is shaped) is what is under test here; the pure
// verdict math is proven separately in `scroll-cert.test.ts`.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "../components/ui/button";
import {
  type Box,
  certifyWidget,
  collectInteractive,
  collectScrollers,
  locate,
  mapGeometryProvider,
} from "./widget-cert";

afterEach(cleanup);

const box = (
  top: number,
  left: number,
  width: number,
  height: number,
): Box => ({ top, left, width, height });

/* ── the harness collects the right elements ────────────────────────────── */

describe("collectInteractive", () => {
  it("finds native + role + tabindex controls, skips ignored/disabled/hidden", () => {
    const { container } = render(
      // Deliberately constructs edge-case DOM (role=button spans, tabindex divs,
      // disabled/hidden buttons) to prove the sweep's element-collection
      // selector + filters — a11y semantics are not under test here.
      <div>
        <button type="button" data-testid="a">
          a
        </button>
        <a href="#x" data-testid="b">
          b
        </a>
        <span role="button" data-testid="c">
          c
        </span>
        <div tabIndex={0} data-testid="d">
          d
        </div>
        <button type="button" data-testid="ignored" data-tap-target="ignore">
          ignore me
        </button>
        <button type="button" data-testid="disabled" disabled>
          off
        </button>
        <span aria-hidden="true" role="button" data-testid="hidden">
          hidden
        </span>
        <div tabIndex={-1} data-testid="neg">
          not focusable
        </div>
        <span data-testid="decorative">just text</span>
      </div>,
    );
    const found = collectInteractive(container).map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(found).toEqual(["a", "b", "c", "d"]);
  });
});

describe("collectScrollers", () => {
  it("finds opted-in scroll containers", () => {
    const { container } = render(
      <div>
        <div data-scroll-cert-scroller data-testid="s1">
          scroller
        </div>
        <div id="continuous-thread">thread</div>
        <div>not a scroller</div>
      </div>,
    );
    const ids = collectScrollers(container).map(
      (el) => el.getAttribute("data-testid") || el.id,
    );
    expect(ids).toContain("s1");
    expect(ids).toContain("continuous-thread");
    expect(ids).toHaveLength(2);
  });
});

describe("locate", () => {
  it("prefers testid > tap-target > aria-label > id > text", () => {
    const mk = (html: string) => {
      const d = document.createElement("div");
      d.innerHTML = html;
      return d.firstElementChild as Element;
    };
    expect(locate(mk('<button data-testid="send">x</button>'))).toBe(
      '[data-testid="send"]',
    );
    expect(locate(mk('<button aria-label="Close">x</button>'))).toBe(
      'button[aria-label="Close"]',
    );
    expect(locate(mk('<button id="ok">x</button>'))).toBe("#ok");
    expect(locate(mk("<button>Save changes</button>"))).toBe(
      'button:"Save changes"',
    );
  });
});

/* ── first certified widget: the demo-buttons view ──────────────────────── */

/**
 * A button-dense interactive surface — the "demo buttons view" the device
 * review called out for too-small controls (#14317 / #14380). We render the
 * real `Button` primitive across its sizes so the cert catches the ACTUAL
 * undersized variants (default h-10=40, sm h-9=36, icon-sm h-8=32 are all
 * below the 44px floor) — this is a genuine finding, reported not fixed
 * (component sizing is owned by wt-14399 / wt-13453).
 */
function DemoButtonsView() {
  return (
    <div data-testid="demo-buttons">
      <Button data-testid="btn-lg" size="lg">
        Large
      </Button>
      <Button data-testid="btn-default" size="default">
        Default
      </Button>
      <Button data-testid="btn-sm" size="sm">
        Small
      </Button>
      <Button data-testid="btn-icon" size="icon" aria-label="icon">
        i
      </Button>
      <Button data-testid="btn-icon-sm" size="icon-sm" aria-label="icon small">
        s
      </Button>
    </div>
  );
}

/** Map a Button test size class to the px box it lays out to (Tailwind h-*). */
const BUTTON_BOXES: Record<string, Box> = {
  "btn-lg": box(0, 0, 88, 44), // h-11 = 44 (passes)
  "btn-default": box(0, 0, 96, 40), // h-10 = 40 (FAILS)
  "btn-sm": box(0, 0, 72, 36), // h-9 = 36 (FAILS)
  "btn-icon": box(0, 0, 40, 40), // h-10 w-10 = 40 (FAILS)
  "btn-icon-sm": box(0, 0, 32, 32), // h-8 w-8 = 32 (FAILS)
};

describe("certifyWidget — demo-buttons view (tap-target)", () => {
  it("catches every sub-44px button and passes the compliant one", () => {
    const { container } = render(<DemoButtonsView />);
    const controls = collectInteractive(container);
    const provider = mapGeometryProvider(
      controls.map((el) => {
        const id = el.getAttribute("data-testid") ?? "";
        return [el, { box: BUTTON_BOXES[id] ?? box(0, 0, 44, 44) }] as const;
      }),
    );

    const report = certifyWidget("demo-buttons", container, provider, {
      dimensions: ["tap-target"],
    });

    expect(report.passed).toBe(false);
    const failedTargets = report.violations.map((v) => v.target);
    // The four undersized variants are all flagged.
    expect(failedTargets).toEqual(
      expect.arrayContaining([
        '[data-testid="btn-default"]',
        '[data-testid="btn-sm"]',
        '[data-testid="btn-icon"]',
        '[data-testid="btn-icon-sm"]',
      ]),
    );
    // The 44px `lg` button is NOT flagged.
    expect(failedTargets).not.toContain('[data-testid="btn-lg"]');
    // Every violation is tap-target class with an actionable message.
    for (const v of report.violations) {
      expect(v.dimension).toBe("tap-target");
      expect(v.message).toMatch(/below the 44×44px minimum/);
    }
  });

  it("passes when an undersized glyph carries an expanded hit box", () => {
    const { container } = render(
      <div data-testid="w">
        <button type="button" data-testid="icon-only" aria-label="menu">
          ≡
        </button>
      </div>,
    );
    const el = collectInteractive(container)[0];
    const provider = mapGeometryProvider([
      [el, { box: box(0, 0, 24, 24), effectiveHitBox: box(-10, -10, 44, 44) }],
    ]);
    const report = certifyWidget("icon-btn", container, provider, {
      dimensions: ["tap-target"],
    });
    expect(report.passed).toBe(true);
  });
});

/* ── certified widget: the chat transcript scroller ─────────────────────── */

describe("certifyWidget — transcript scroller (scroll)", () => {
  it("passes a bounded overflow scroller that scrolls + contains overscroll", () => {
    const { container } = render(
      <div>
        <div id="continuous-thread">messages</div>
      </div>,
    );
    const scroller = container.querySelector(
      "#continuous-thread",
    ) as Element & {
      scrollHeight: number;
      scrollWidth: number;
    };
    Object.defineProperty(scroller, "scrollHeight", {
      value: 2400,
      configurable: true,
    });
    Object.defineProperty(scroller, "scrollWidth", {
      value: 402,
      configurable: true,
    });

    const provider = mapGeometryProvider([
      [
        scroller,
        {
          box: box(120, 0, 402, 700),
          overflowY: "auto",
          overflowX: "hidden",
          overscrollBehaviorY: "contain",
          midScrollTopSettled: 850,
        },
      ],
    ]);
    const report = certifyWidget("transcript", scroller, provider, {
      dimensions: ["scroll"],
      nestedScrollers: { "#continuous-thread": true },
    });
    expect(report.passed).toBe(true);
  });

  it("catches a collapsed height chain (the can't-scroll bug)", () => {
    const { container } = render(<div id="continuous-thread">messages</div>);
    const scroller = container.querySelector(
      "#continuous-thread",
    ) as Element & {
      scrollHeight: number;
      scrollWidth: number;
    };
    Object.defineProperty(scroller, "scrollHeight", {
      value: 2400,
      configurable: true,
    });
    Object.defineProperty(scroller, "scrollWidth", {
      value: 402,
      configurable: true,
    });
    const provider = mapGeometryProvider([
      [
        scroller,
        {
          box: box(120, 0, 402, 700),
          overflowY: "auto",
          overflowX: "hidden",
          overscrollBehaviorY: "contain",
          midScrollTopSettled: 0, // clamped to 0 → sized to content
        },
      ],
    ]);
    const report = certifyWidget("transcript", scroller, provider, {
      dimensions: ["scroll"],
    });
    expect(report.passed).toBe(false);
    expect(report.violations.map((v) => v.code)).toContain(
      "scroll/height-chain-collapsed",
    );
  });
});

/* ── certified widget: a list view (safe-area) ──────────────────────────── */

describe("certifyWidget — list view (safe-area)", () => {
  it("flags a control that sits under the bottom home indicator", () => {
    const { container } = render(
      <div data-testid="list">
        <button type="button" data-testid="row-1">
          row 1
        </button>
        <button type="button" data-testid="row-last">
          row last
        </button>
      </div>,
    );
    const controls = collectInteractive(container);
    const provider = mapGeometryProvider([
      [controls[0], { box: box(120, 0, 402, 56) }],
      [controls[1], { box: box(850, 0, 402, 56) }], // bottom = 906, past 840 line
    ]);
    const report = certifyWidget("list", container, provider, {
      dimensions: ["safe-area"],
      safeArea: { insetTop: 59, insetBottom: 34, viewportHeight: 874 },
    });
    expect(report.passed).toBe(false);
    const v = report.violations.find(
      (x) => x.code === "safe-area/under-bottom-inset",
    );
    expect(v?.target).toBe('[data-testid="row-last"]');
  });
});
