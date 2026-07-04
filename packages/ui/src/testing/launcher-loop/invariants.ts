/**
 * Launcher-loop invariants — the §D `[I]` checks run after EVERY command,
 * comparing a real observation (`cdp-gestures.ts`) against the pure model
 * (`model.ts`). Each check returns an error string on violation (or null when
 * satisfied); `checkInvariants` runs them all and returns every failure so a
 * single command reports the complete divergence, not just the first.
 *
 * These are the properties the launcher must hold no matter what sequence of
 * gestures produced the state: page/probe/transform agreement, focus never in
 * the inert half, telemetry launch count tracking real taps, zero console
 * errors, a CLS budget, and no blue anywhere (brand gate).
 */

import type { LauncherObservation } from "./cdp-gestures";
import type { LauncherModelState } from "./model";

export interface InvariantContext {
  /** CLS budget for the whole run (cumulative layout-shift score ceiling). */
  readonly clsBudget: number;
  /**
   * Tolerance (px) for the at-rest rail transform check — the rail parks at
   * `-page * viewportWidth`, allowing sub-pixel rounding from the transform.
   */
  readonly transformTolerancePx: number;
}

export const DEFAULT_INVARIANT_CONTEXT: InvariantContext = {
  clsBudget: 0.1,
  transformTolerancePx: 1.5,
};

/**
 * Run every invariant against `(model, observed)`. Returns the list of
 * violation messages — empty means the surface agrees with the model on all
 * checked properties.
 */
export function checkInvariants(
  model: LauncherModelState,
  observed: LauncherObservation,
  ctx: InvariantContext = DEFAULT_INVARIANT_CONTEXT,
): string[] {
  const failures: string[] = [];
  for (const check of INVARIANTS) {
    const failure = check(model, observed, ctx);
    if (failure) failures.push(failure);
  }
  return failures;
}

type Invariant = (
  model: LauncherModelState,
  observed: LauncherObservation,
  ctx: InvariantContext,
) => string | null;

/** §D item 23: `data-page` matches the model's page and is one of the two. */
const pageAttrMatchesModel: Invariant = (model, observed) => {
  if (observed.dataPage !== "home" && observed.dataPage !== "launcher") {
    return `data-page="${observed.dataPage}" is not one of {home, launcher}`;
  }
  if (observed.dataPage !== model.page) {
    return `data-page="${observed.dataPage}" but model expects "${model.page}"`;
  }
  return null;
};

/** §D item 23: the sr-only AX probe mirrors `data-page` (XCUITest contract). */
const probeMirrorsPage: Invariant = (model, observed) => {
  const expected = `home-launcher-page:${model.page}`;
  if (observed.probeText !== expected) {
    return `page-probe "${observed.probeText}" != expected "${expected}"`;
  }
  return null;
};

/** §D item 23: at rest the rail transform equals `-page * viewportWidth`. */
const transformAtRest: Invariant = (model, observed, ctx) => {
  const pageIndex = model.page === "launcher" ? 1 : 0;
  const expected = -pageIndex * observed.viewportWidth;
  if (Math.abs(observed.railTransformX - expected) > ctx.transformTolerancePx) {
    return `rail transformX=${observed.railTransformX.toFixed(2)} but expected ${expected.toFixed(2)} (page="${model.page}", width=${observed.viewportWidth})`;
  }
  return null;
};

/** §D item 23: exactly one half is visible — the other is inert. */
const exactlyOneHalfInert: Invariant = (model, observed) => {
  const expectHomeInert = model.page !== "home";
  const expectLauncherInert = model.page !== "launcher";
  if (observed.homeInert !== expectHomeInert) {
    return `home half inert=${observed.homeInert} but expected ${expectHomeInert} on page "${model.page}"`;
  }
  if (observed.launcherInert !== expectLauncherInert) {
    return `launcher half inert=${observed.launcherInert} but expected ${expectLauncherInert} on page "${model.page}"`;
  }
  return null;
};

/** §D item 21: focus is never inside an inert offscreen half. */
const focusNeverInInert: Invariant = (_model, observed) => {
  if (observed.activeElementInInert) {
    return "document.activeElement is inside an [inert] offscreen half";
  }
  return null;
};

/** §D item 10: telemetry launch count equals the model's committed launches. */
const launchCountMatchesModel: Invariant = (model, observed) => {
  if (observed.launchCount !== model.launchCount) {
    return `telemetry launch count=${observed.launchCount} but model expects ${model.launchCount} (ghost or dropped launch)`;
  }
  return null;
};

/** §D item 41: no blue sampled anywhere on the surface (brand gate). */
const noBlue: Invariant = (_model, observed) => {
  if (observed.blueSampleCount > 0) {
    return `${observed.blueSampleCount} element(s) sampled blue on the launcher surface (orange accent only)`;
  }
  return null;
};

/** Zero console errors / uncaught rejections across the run. */
const noConsoleErrors: Invariant = (_model, observed) => {
  if (observed.consoleErrorCount > 0) {
    return `${observed.consoleErrorCount} console error(s)/uncaught rejection(s) during the loop`;
  }
  return null;
};

/** §D item 36: cumulative layout shift stays within budget. */
const clsWithinBudget: Invariant = (_model, observed, ctx) => {
  if (observed.layoutShiftScore > ctx.clsBudget) {
    return `CLS ${observed.layoutShiftScore.toFixed(4)} exceeds budget ${ctx.clsBudget}`;
  }
  return null;
};

const INVARIANTS: readonly Invariant[] = [
  pageAttrMatchesModel,
  probeMirrorsPage,
  transformAtRest,
  exactlyOneHalfInert,
  focusNeverInInert,
  launchCountMatchesModel,
  noBlue,
  noConsoleErrors,
  clsWithinBudget,
];
