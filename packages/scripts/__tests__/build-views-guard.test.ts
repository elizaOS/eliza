/**
 * Guards the view-build CLI and missing-output contracts without spawning Vite.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  expectedBundlePath,
  missingBundleReport,
  parseViewFilter,
} from "../build-views.mjs";

describe("build-views bundle guard (#15791)", () => {
  test("expectedBundlePath resolves the required emit target", () => {
    const configPath = path.join(
      "/repo",
      "plugins",
      "plugin-polymarket",
      "vite.config.views.ts",
    );
    expect(expectedBundlePath(configPath)).toBe(
      path.join(
        "/repo",
        "plugins",
        "plugin-polymarket",
        "dist",
        "views",
        "bundle.js",
      ),
    );
  });

  test("a build with no missing bundles reports success (null)", () => {
    expect(missingBundleReport([])).toBeNull();
  });

  test("a configured view that emitted no bundle fails observably", () => {
    const report = missingBundleReport([
      {
        name: "plugin-polymarket",
        relativeBundle: "plugins/plugin-polymarket/dist/views/bundle.js",
        relativeConfig: "plugins/plugin-polymarket/vite.config.views.ts",
      },
    ]);
    expect(report).not.toBeNull();
    expect(report).toContain("plugin-polymarket");
    expect(report).toContain("missing after build");
  });

  test("parses one complete filter and rejects every ignored argument", () => {
    expect(parseViewFilter([])).toBeUndefined();
    expect(parseViewFilter(["--filter", "plugin-feed"])).toBe("plugin-feed");
    expect(parseViewFilter(["--filter=@elizaos/plugin-feed"])).toBe(
      "@elizaos/plugin-feed",
    );
    expect(() => parseViewFilter(["--filter"])).toThrow(/requires/);
    expect(() => parseViewFilter(["--filter", "-h"])).toThrow(/requires/);
    expect(() => parseViewFilter(["--filter="])).toThrow(/requires/);
    expect(() =>
      parseViewFilter(["--filter=plugin-feed", "--filter", "plugin-todos"]),
    ).toThrow(/only once/);
    expect(() => parseViewFilter(["--ignored"])).toThrow(/unknown argument/);
  });
});
