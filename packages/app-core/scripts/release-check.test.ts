import { describe, expect, it } from "vitest";

import {
  findLocalPackHotspots,
  shouldSkipExactPackDryRun,
} from "./lib/release-check-pack-dry-run";
import { findNonWorkspaceDependencySpecs } from "./release-check";

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

describe("release-check cloud-agent template guard", () => {
  it("accepts workspace-local elizaOS dependencies in source", () => {
    expect(
      findNonWorkspaceDependencySpecs(
        {
          dependencies: {
            "@elizaos/core": "workspace:*",
            "@elizaos/plugin-sql": "workspace:*",
          },
        },
        ["@elizaos/core", "@elizaos/plugin-sql"],
      ),
    ).toEqual([]);
  });

  it("rejects committed alpha pins in the source template", () => {
    expect(
      findNonWorkspaceDependencySpecs(
        {
          dependencies: {
            "@elizaos/core": "2.0.0-alpha.341",
          },
        },
        ["@elizaos/core"],
      ),
    ).toEqual([
      {
        name: "@elizaos/core",
        specifier: "2.0.0-alpha.341",
      },
    ]);
  });
});
