/** Verifies the deterministic app-core npm asset manifest without copying files. */
import { describe, expect, it } from "vitest";
import { PUBLISH_ASSET_PATHS } from "./copy-publish-assets.mjs";

describe("app-core publish asset manifest", () => {
  it("lists each reviewed source root exactly once", () => {
    expect(PUBLISH_ASSET_PATHS).toEqual([
      "src/styles",
      "scripts",
      "platforms",
      "packaging",
      "patches",
      "test/scripts",
      "test/helpers",
    ]);
    expect(new Set(PUBLISH_ASSET_PATHS).size).toBe(
      PUBLISH_ASSET_PATHS.length,
    );
  });

  it("does not publish generated or dependency roots", () => {
    expect(PUBLISH_ASSET_PATHS).not.toContain("dist");
    expect(PUBLISH_ASSET_PATHS).not.toContain("node_modules");
    expect(PUBLISH_ASSET_PATHS).not.toContain("platforms/electrobun/build");
  });
});
