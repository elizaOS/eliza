/**
 * Schema + comparator contract tests for the view-bundle-size gate (#10724).
 *
 * Run: bun test packages/benchmarks/view-bundle-size/metric-schema.test.ts
 *
 * These pin the per-bundle field set AND the null-not-zero honesty contract in
 * the comparator: a bundle that did not build (measured:false, gzipBytes:null)
 * can NEVER satisfy a budget, no matter how generous. No filesystem, no build:
 * pure schema + pure-function assertions, CI-safe everywhere.
 */

import { describe, expect, it } from "bun:test";

import {
  BUNDLE_METRIC_SCHEMA,
  BUNDLE_METRIC_SCHEMA_VERSION,
  compareBundleBudget,
  compareTotalBudget,
  measuredBundleRow,
  SIZE_UNIT,
  skippedBundleRow,
} from "./metric-schema.mjs";

describe("view-bundle-size metric schema", () => {
  it("gates on gzipped bytes and declares its version", () => {
    expect(SIZE_UNIT).toBe("gzip-bytes");
    expect(BUNDLE_METRIC_SCHEMA.sizeUnit).toBe(SIZE_UNIT);
    expect(BUNDLE_METRIC_SCHEMA.version).toBe(BUNDLE_METRIC_SCHEMA_VERSION);
    expect(BUNDLE_METRIC_SCHEMA.issue).toBe("#10724");
  });

  it("pins the per-bundle field names", () => {
    expect(BUNDLE_METRIC_SCHEMA.bundleFields).toEqual([
      "name",
      "measured",
      "skipReason",
      "rawBytes",
      "gzipBytes",
      "files",
    ]);
  });

  it("skippedBundleRow yields a measured:false row with sizes null (never 0)", () => {
    const row = skippedBundleRow("plugin-todos", "did not build");
    expect(row.measured).toBe(false);
    expect(row.skipReason).toBe("did not build");
    // Never conflate "not measured" with "0 bytes".
    expect(row.rawBytes).toBeNull();
    expect(row.gzipBytes).toBeNull();
    expect(row.files).toEqual([]);
    // Every pinned field is present.
    for (const field of BUNDLE_METRIC_SCHEMA.bundleFields) {
      expect(field in row).toBe(true);
    }
  });

  it("measuredBundleRow requires real numeric sizes", () => {
    const row = measuredBundleRow("plugin-todos", {
      rawBytes: 5853,
      gzipBytes: 2087,
      files: ["bundle.js"],
    });
    expect(row.measured).toBe(true);
    expect(row.gzipBytes).toBe(2087);
    expect(row.files).toEqual(["bundle.js"]);
    // A "measured" row with a null size is a contradiction — reject it.
    expect(() =>
      measuredBundleRow("x", {
        rawBytes: 1,
        gzipBytes: null as unknown as number,
      }),
    ).toThrow();
  });
});

describe("view-bundle-size budget comparator (null-not-zero contract)", () => {
  it("passes a measured bundle at or under budget", () => {
    const row = measuredBundleRow("a", { rawBytes: 10, gzipBytes: 2000 });
    expect(compareBundleBudget(row, 2500).pass).toBe(true);
    expect(compareBundleBudget(row, 2000).pass).toBe(true); // exactly at budget
  });

  it("fails a measured bundle over budget", () => {
    const row = measuredBundleRow("a", { rawBytes: 10, gzipBytes: 3000 });
    const check = compareBundleBudget(row, 2500);
    expect(check.pass).toBe(false);
    expect(check.gzipBytes).toBe(3000);
    expect(check.budget).toBe(2500);
  });

  it("NEVER passes an unmeasured bundle, even against a huge budget", () => {
    const row = skippedBundleRow("a", "did not build");
    const check = compareBundleBudget(row, 10_000_000);
    // null is not zero: "did not build" can never read as "under budget".
    expect(check.measured).toBe(false);
    expect(check.gzipBytes).toBeNull();
    expect(check.pass).toBe(false);
  });

  it("never passes when there is no numeric budget", () => {
    const row = measuredBundleRow("a", { rawBytes: 10, gzipBytes: 100 });
    expect(compareBundleBudget(row, undefined).pass).toBe(false);
    expect(compareBundleBudget(row, null).pass).toBe(false);
  });

  it("total comparator: passes under budget, fails over, null when nothing measured", () => {
    expect(compareTotalBudget(100, 200, { measuredBundles: 3 }).pass).toBe(
      true,
    );
    expect(compareTotalBudget(300, 200, { measuredBundles: 3 }).pass).toBe(
      false,
    );
    const none = compareTotalBudget(0, 200, { measuredBundles: 0 });
    expect(none.measured).toBe(false);
    expect(none.gzipBytes).toBeNull();
    expect(none.pass).toBe(false);
  });
});
