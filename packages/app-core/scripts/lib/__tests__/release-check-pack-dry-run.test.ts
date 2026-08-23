import { describe, expect, it } from "vitest";
import {
  findLocalPackHotspots,
  shouldSkipExactPackDryRun,
} from "../release-check-pack-dry-run.ts";

describe("findLocalPackHotspots", () => {
  it("finds existing hotspots with injected checker", () => {
    const exists = (c: string) => c === "dist" || c === "packages/app/dist";
    const hotspots = findLocalPackHotspots(
      ["dist", "apps/app/dist", "packages/app/dist"],
      exists,
    );
    expect(hotspots).toEqual(["dist", "packages/app/dist"]);
  });

  it("returns empty when nothing exists", () => {
    expect(findLocalPackHotspots(["dist"], () => false)).toEqual([]);
  });

  it("uses the default hotspot list", () => {
    expect(Array.isArray(findLocalPackHotspots())).toBe(true);
  });
});

describe("shouldSkipExactPackDryRun", () => {
  it("skips when hotspots exist", () => {
    expect(shouldSkipExactPackDryRun(["dist"], {})).toBe(true);
  });

  it("does not skip without hotspots", () => {
    expect(shouldSkipExactPackDryRun([], {})).toBe(false);
  });

  it("force env overrides skipping", () => {
    expect(
      shouldSkipExactPackDryRun(["dist"], { ELIZA_FORCE_PACK_DRY_RUN: "1" }),
    ).toBe(false);
  });
});
