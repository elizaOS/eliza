/**
 * Guards the view-build CLI and missing-output contracts without spawning Vite.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertSafeViewOutputDirectory,
  expectedBundlePath,
  missingBundleReport,
  parseViewFilter,
} from "../build-views.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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

  test("refuses recursive cleanup through a symlinked output ancestor", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "view-cleanup-"));
    tempDirs.push(root);
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "must-survive.txt"), "survives");
    fs.symlinkSync(outside, path.join(workspace, "dist"));
    const config = path.join(workspace, "vite.config.views.ts");
    fs.writeFileSync(config, "export {};\n");

    expect(() => assertSafeViewOutputDirectory(config)).toThrow(
      "refusing to clean symlinked output path",
    );
    expect(
      fs.readFileSync(path.join(outside, "must-survive.txt"), "utf8"),
    ).toBe("survives");
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
