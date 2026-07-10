// Guards the build-views failure contract (#15791): a build that emits no
// bundle for a configured plugin view must fail, and stale outputs are cleared
// before each build. Imports the real helpers — build-views only runs its
// orchestration under import.meta.main, so importing it here is side-effect free.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { expectedBundlePath, missingBundleReport } from "../build-views.mjs";

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
});
