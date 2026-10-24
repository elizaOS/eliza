/**
 * Verifies the published manifest maps each export to the file the package
 * build actually emits, including module-format-specific `.mjs` entries.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { preparePackageDist } from "../prepare-package-dist.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function prepare(exports: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "eliza-prepare-dist-"));
  temporaryDirectories.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
  );
  mkdirSync(join(root, "packages/demo"), { recursive: true });
  writeFileSync(
    join(root, "packages/demo/package.json"),
    JSON.stringify({
      name: "@fixture/demo",
      version: "1.0.0",
      type: "module",
      main: "./src/index.ts",
      exports,
    }),
  );
  return preparePackageDist({
    repositoryRoot: root,
    packageDirectory: "packages/demo",
    optionalPluginFallbackVersions: {},
  });
}

describe("prepare-package-dist", () => {
  test("keeps .mjs and .d.mts targets instead of renaming them to .js", () => {
    const manifest = prepare({
      ".": "./src/index.ts",
      "./value-formatting.mjs": {
        "eliza-source": "./src/utils/value-formatting.mjs",
        types: "./dist/utils/value-formatting.d.mts",
        import: "./dist/utils/value-formatting.mjs",
        default: "./dist/utils/value-formatting.mjs",
      },
      "./worker.cjs": "./src/worker.cts",
    });

    expect(manifest.main).toBe("./index.js");
    expect(manifest.exports["."]).toEqual({
      types: "./index.d.ts",
      import: "./index.js",
      default: "./index.js",
    });
    expect(manifest.exports["./value-formatting.mjs"]).toEqual({
      "eliza-source": "./utils/value-formatting.mjs",
      types: "./utils/value-formatting.d.mts",
      import: "./utils/value-formatting.mjs",
      default: "./utils/value-formatting.mjs",
    });
    expect(manifest.exports["./worker.cjs"]).toEqual({
      types: "./worker.d.cts",
      import: "./worker.cjs",
      default: "./worker.cjs",
    });
  });

  test("rewrites .tsx, .d.ts and extensionless targets to .js", () => {
    const manifest = prepare({
      "./view": { types: "./src/view.d.ts", import: "./src/view.tsx" },
      "./bare": "./src/bare",
      "./icons/*": "./src/icons/*.tsx",
    });

    expect(manifest.exports["./view"]).toEqual({
      types: "./view.d.ts",
      import: "./view.js",
    });
    expect(manifest.exports["./bare"]).toEqual({
      types: "./bare.d.ts",
      import: "./bare.js",
      default: "./bare.js",
    });
    expect(manifest.exports["./icons/*"]).toEqual({
      types: "./icons/*.d.ts",
      import: "./icons/*.js",
      default: "./icons/*.js",
    });
  });
});
