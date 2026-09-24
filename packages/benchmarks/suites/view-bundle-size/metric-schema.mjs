/**
 * Shared view-bundle-size metric schema (issue #10724).
 *
 * The single source of truth for the per-bundle record the size gate emits and
 * for the budget comparator that turns a measured size into a pass/fail. Kept in
 * its own module (pure ESM, built-ins only) so BOTH the harness
 * (`bundle-size-kpi.mjs`) and the unit test (`metric-schema.test.ts`) import the
 * exact same shapes and the exact same comparator — the null-not-zero honesty
 * contract is pinned in one place.
 *
 * Honesty contract (no fabricated sizes, no always-pass stub):
 *   - A bundle row is `measured: true` ONLY when its `dist/views/*.js|css`
 *     actually built and was sized. A bundle that failed to build is
 *     `measured: false` with a concrete `skipReason` and sizes `null` — NEVER
 *     `0`. "did not build" must never read as "0 bytes, comfortably under
 *     budget".
 *   - `compareBundleBudget` (and `compareTotalBudget`) therefore NEVER return
 *     `pass: true` for an unmeasured row: `null` is not `<=` any budget. An
 *     unmeasured bundle can never satisfy a budget.
 *
 * The gate unit is gzipped bytes — the meaningful "over the wire" size. Raw
 * bytes are recorded for context but not gated.
 */

/** Schema version. Bump on any breaking field change so consumers detect drift. */
export const BUNDLE_METRIC_SCHEMA_VERSION = "1.0.0";

/** The unit every gated size is expressed in. */
export const SIZE_UNIT = "gzip-bytes";

/** The top-level report envelope / field contract. */
export const BUNDLE_METRIC_SCHEMA = Object.freeze({
  version: BUNDLE_METRIC_SCHEMA_VERSION,
  sizeUnit: SIZE_UNIT,
  /** Field names present on every per-bundle row. */
  bundleFields: Object.freeze([
    "name",
    "measured",
    "skipReason",
    "rawBytes",
    "gzipBytes",
    "files",
  ]),
  /** Field names present on the run totals block. */
  totalsFields: Object.freeze([
    "expectedBundles",
    "measuredBundles",
    "skippedBundles",
    "totalRawBytes",
    "totalGzipBytes",
  ]),
  /** Owner issue. */
  issue: "#10724",
});

/**
 * Build a skipped (did-not-build) bundle row. Every numeric size is `null`
 * (never `0`) so it can never masquerade as a tiny, in-budget bundle.
 *
 * @param {string} name       Plugin directory name (e.g. "plugin-todos").
 * @param {string} skipReason Why this bundle was not measured.
 */
export function skippedBundleRow(name, skipReason) {
  return {
    name,
    measured: false,
    skipReason,
    rawBytes: null,
    gzipBytes: null,
    files: [],
  };
}

/**
 * Build a measured bundle row. Throws if the sizes are not real numbers — a
 * measured row must carry real, non-null sizes (the inverse of the contract
 * above).
 *
 * @param {string} name
 * @param {{ rawBytes: number, gzipBytes: number, files?: string[] }} sizes
 */
export function measuredBundleRow(name, { rawBytes, gzipBytes, files } = {}) {
  if (typeof rawBytes !== "number" || typeof gzipBytes !== "number") {
    throw new Error(
      `[view-bundle-size] measuredBundleRow("${name}") requires numeric rawBytes/gzipBytes`,
    );
  }
  return {
    name,
    measured: true,
    rawBytes,
    gzipBytes,
    files: Array.isArray(files) ? files : [],
  };
}

/**
 * Compare one bundle row against its per-bundle gzip budget.
 *
 * Honesty contract: a row is only `pass: true` when it was really measured AND
 * its gzip size is at or under a real numeric budget. An unmeasured row
 * (`gzipBytes === null`) or an absent budget can never pass — `null` is not
 * zero, so "did not build" never satisfies a budget.
 *
 * @param {{ name: string, measured: boolean, gzipBytes: number|null }} row
 * @param {number|null|undefined} budgetGzipBytes
 * @returns {{ name: string, measured: boolean, gzipBytes: number|null, budget: number|null, pass: boolean }}
 */
export function compareBundleBudget(row, budgetGzipBytes) {
  const measured = row.measured === true && typeof row.gzipBytes === "number";
  const hasBudget = typeof budgetGzipBytes === "number";
  return {
    name: row.name,
    measured,
    gzipBytes: measured ? row.gzipBytes : null,
    budget: hasBudget ? budgetGzipBytes : null,
    pass: measured && hasBudget && row.gzipBytes <= budgetGzipBytes,
  };
}

/**
 * Compare the summed gzip size of the measured bundles against the total budget.
 * Same honesty contract: with nothing measured, the total is `null` and can
 * never pass.
 *
 * @param {number|null} totalGzipBytes  Sum of measured gzip sizes.
 * @param {number|null|undefined} budgetGzipBytes
 * @param {{ measuredBundles: number }} ctx
 */
export function compareTotalBudget(totalGzipBytes, budgetGzipBytes, ctx = {}) {
  const measured =
    typeof totalGzipBytes === "number" && (ctx.measuredBundles ?? 0) > 0;
  const hasBudget = typeof budgetGzipBytes === "number";
  return {
    name: "total.gzipBytes",
    measured,
    gzipBytes: measured ? totalGzipBytes : null,
    budget: hasBudget ? budgetGzipBytes : null,
    pass: measured && hasBudget && totalGzipBytes <= budgetGzipBytes,
  };
}
