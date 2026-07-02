// @vitest-environment jsdom
//
// Unit guard for the shell back-button clearance seam (#11144).
//
// The fixed ShellBackButton (top-left, z-60) floats over the routed shell, so
// nothing in normal flow reserves space for it. The seam that keeps it from
// occluding the FIRST filter chip of the unified spatial views (Inbox "Email",
// Relationships "All", Health "7d") is a two-sided CSS-var contract:
//
//   set side  (App.tsx)          — every shell wrapper that renders
//                                  <ShellBackButton> sets
//                                  --shell-backnav-clearance on the same
//                                  wrapper element;
//   consume side (spatial/dom.tsx) — SpatialSurface pads its top by
//                                  var(--shell-backnav-clearance, 0px), so the
//                                  view's first row starts below the button,
//                                  and surfaces mounted outside the routed
//                                  shell (chat overlay, XR, TUI, stories) get
//                                  no phantom inset.
//
// The var name is a cross-file string contract with no shared symbol, so this
// test guards BOTH sides (source-level guard on App.tsx follows the
// App.safe-area-fill.test.ts precedent) plus the geometry that makes the
// clearance sufficient. The end-to-end hit-test lives in
// packages/app/test/ui-smoke/apps-personal-assistant-decomposed-interactions.spec.ts.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SpatialSurface } from "./dom.tsx";

const here = dirname(fileURLToPath(import.meta.url));
const APP_SRC = readFileSync(join(here, "..", "App.tsx"), "utf8");

const CLEARANCE_VAR = "--shell-backnav-clearance";

afterEach(cleanup);

describe("shell back-button clearance seam (#11144)", () => {
  it("SpatialSurface consumes the clearance var as top padding with a 0px default", () => {
    const { container, getByRole } = render(
      <SpatialSurface modality="gui">
        <div>
          <button type="button">Email</button>
        </div>
      </SpatialSurface>,
    );
    const surface = container.querySelector<HTMLElement>(
      "[data-spatial-surface]",
    );
    expect(surface).not.toBeNull();
    // The exact declaration matters: consuming the var puts the first chip row
    // below the button inside the routed shell, and the 0px fallback keeps
    // every surface outside it (chat overlay, XR, TUI, stories) flush.
    expect(surface?.style.paddingTop).toBe(`var(${CLEARANCE_VAR}, 0px)`);
    // The chip row is inside the padded surface, so the padding displaces it.
    expect(surface?.contains(getByRole("button", { name: "Email" }))).toBe(
      true,
    );
  });

  it("every shell wrapper that renders ShellBackButton sets the clearance var on itself", () => {
    const sites: number[] = [];
    for (
      let idx = APP_SRC.indexOf("<ShellBackButton");
      idx !== -1;
      idx = APP_SRC.indexOf("<ShellBackButton", idx + 1)
    ) {
      sites.push(idx);
    }
    // RoutedShellContent + FullBleedShellContent (ChatRouteShellContent has no
    // back button — chat is the navigation root).
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const site of sites) {
      const wrapperOpen = APP_SRC.lastIndexOf("<div", site);
      expect(wrapperOpen).toBeGreaterThan(-1);
      const wrapperTag = APP_SRC.slice(wrapperOpen, site);
      expect(
        wrapperTag.includes(`"${CLEARANCE_VAR}"`),
        `a shell wrapper renders <ShellBackButton> without setting ${CLEARANCE_VAR} — its spatial views' first chip row will sit under the button (#11144)`,
      ).toBe(true);
    }
  });

  it("the reserved clearance covers the button's top offset + height", () => {
    // Button geometry from ShellBackButton's className: fixed at
    // top-[calc(var(--safe-area-top,0px)+<offset>rem)] with a Tailwind h-<n>
    // height (n * 0.25rem). The clearance each wrapper reserves must be at
    // least offset + height, or the padded chip row still starts under the
    // button's bottom edge.
    const bottomEdgeRem = buttonBottomEdgeRem(0);
    const evaluators = parseClearanceEvaluators();
    // Per-wrapper coverage is the previous test's job; this one just must not
    // pass vacuously.
    expect(evaluators.length).toBeGreaterThanOrEqual(1);
    for (const clearanceRem of evaluators) {
      expect(
        clearanceRem(0),
        `${CLEARANCE_VAR} (${clearanceRem(0)}rem at safe-area-top 0) no longer clears the back button's bottom edge (${bottomEdgeRem}rem)`,
      ).toBeGreaterThanOrEqual(bottomEdgeRem);
    }
  });

  it("the clearance still clears the button on notched devices (safe-area-top > 1.25rem)", () => {
    // The clearance padding stacks INSIDE the root content column, which
    // absorbs only max(safe-area-top - shaveRem, floorRem) of the safe area,
    // while the fixed button sits at the FULL safe-area-top + offset in
    // viewport coords. So the chip's viewport top is rootPad + clearance and
    // must reach the button's bottom (safe-area-top + offset + height) at
    // EVERY inset — a flat 3rem clearance passes at safe-area-top 0 (the
    // Playwright lanes) but leaves up to a 1.25rem overlap on notched phones.
    const rootPadMatch = APP_SRC.match(
      /"max\(calc\(var\(--safe-area-top, 0px\) - ([\d.]+)rem\), ([\d.]+)rem\)"/,
    );
    expect(
      rootPadMatch,
      "root content column lost its shaved safe-area paddingTop (App.tsx)",
    ).not.toBeNull();
    const [, shave, floor] = rootPadMatch as RegExpMatchArray;
    const rootPadRem = (satRem: number) =>
      Math.max(satRem - Number(shave), Number(floor));

    const evaluators = parseClearanceEvaluators();
    expect(evaluators.length).toBeGreaterThanOrEqual(1);
    // 24px (just past the 1.25rem floor crossover), 40px (the worst-case
    // boundary where the deficit peaks), 44px (iPhone notch), 59px (Dynamic
    // Island) — all at the 16px root font size.
    for (const satRem of [1.5, 2.5, 2.75, 3.6875]) {
      const buttonBottom = buttonBottomEdgeRem(satRem);
      for (const clearanceRem of evaluators) {
        const chipTop = rootPadRem(satRem) + clearanceRem(satRem);
        expect(
          chipTop,
          `at --safe-area-top ${satRem}rem the first chip row's top (${chipTop}rem) sits above the back button's bottom edge (${buttonBottom}rem) — the button occludes the chip (#11144)`,
        ).toBeGreaterThanOrEqual(buttonBottom);
      }
    }
  });
});

/**
 * The back button's bottom edge in viewport rem at a given --safe-area-top,
 * parsed from ShellBackButton's className: fixed at
 * top-[calc(var(--safe-area-top,0px)+<offset>rem)] with a Tailwind h-<n>
 * height (n * 0.25rem).
 */
function buttonBottomEdgeRem(satRem: number): number {
  const btnIdx = APP_SRC.indexOf('data-testid="shell-back-button"');
  expect(btnIdx).toBeGreaterThan(-1);
  const btnTag = APP_SRC.slice(btnIdx, APP_SRC.indexOf(">", btnIdx));

  const topMatch = btnTag.match(
    /top-\[calc\(var\(--safe-area-top,0px\)\+([\d.]+)rem\)\]/,
  );
  expect(topMatch, "back button lost its rem top offset class").not.toBeNull();
  const heightMatch = btnTag.match(/\bh-(\d+(?:\.\d+)?)\b/);
  expect(
    heightMatch,
    "back button lost its Tailwind height class",
  ).not.toBeNull();
  return (
    satRem +
    Number((topMatch as RegExpMatchArray)[1]) +
    Number((heightMatch as RegExpMatchArray)[1]) * 0.25
  );
}

/**
 * Every --shell-backnav-clearance value App.tsx sets, as an evaluator from
 * --safe-area-top (rem) to the resolved clearance (rem). Understands the two
 * shapes the seam has shipped: a flat `<n>rem` and
 * `calc(<n>rem + min(var(--safe-area-top, 0px), <m>rem))`. Every set-site must
 * parse — an unparseable value is a geometry we cannot verify, so it fails
 * loudly instead of being skipped.
 */
function parseClearanceEvaluators(): Array<(satRem: number) => number> {
  const evaluators: Array<(satRem: number) => number> = [];
  for (const match of APP_SRC.matchAll(
    new RegExp(`"${CLEARANCE_VAR}":\\s*"([^"]+)"`, "g"),
  )) {
    const value = match[1];
    const flat = value.match(/^([\d.]+)rem$/);
    if (flat) {
      const rem = Number(flat[1]);
      evaluators.push(() => rem);
      continue;
    }
    const calc = value.match(
      /^calc\(([\d.]+)rem \+ min\(var\(--safe-area-top, 0px\), ([\d.]+)rem\)\)$/,
    );
    expect(
      calc,
      `unparseable ${CLEARANCE_VAR} value "${value}" — teach parseClearanceEvaluators its shape so the geometry stays verified`,
    ).not.toBeNull();
    const [, base, cap] = calc as RegExpMatchArray;
    evaluators.push((satRem) => Number(base) + Math.min(satRem, Number(cap)));
  }
  return evaluators;
}
