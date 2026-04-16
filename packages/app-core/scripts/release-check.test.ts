import { describe, expect, it } from "vitest";

import {
  findLocalPackHotspots,
  shouldSkipExactPackDryRun,
} from "./lib/release-check-pack-dry-run";

describe("release-check pack dry-run guard", () => {
  it("treats broad publish roots as pack hotspots", () => {
    const hotspots = findLocalPackHotspots(
      ["dist", "apps/app/dist", "dist/node_modules"],
      (candidate) => candidate === "dist" || candidate === "apps/app/dist",
    );

    expect(hotspots).toEqual(["dist", "apps/app/dist"]);
  });

  it("skips the exact pack dry-run in CI when hotspot artifacts are present", () => {
    expect(
      shouldSkipExactPackDryRun(["dist", "apps/app/dist"], { CI: "true" }),
    ).toBe(true);
  });

  it("honors the explicit exact-pack override", () => {
    expect(
      shouldSkipExactPackDryRun(["dist"], { ELIZA_FORCE_PACK_DRY_RUN: "1" }),
    ).toBe(false);
  });
});
