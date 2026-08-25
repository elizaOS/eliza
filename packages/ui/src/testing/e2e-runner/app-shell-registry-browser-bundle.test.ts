/**
 * Browser-bundle regression for the app-shell registry. The real esbuild
 * boundary must not traverse either package's broad barrel into Node-only
 * runtime modules.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const uiPackageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

describe("app-shell registry browser bundle", () => {
  it("bundles without broad shared barrels or Node builtins", async () => {
    const result = await build({
      entryPoints: [resolve(uiPackageRoot, "src/app-shell-registry.ts")],
      bundle: true,
      conditions: ["eliza-source", "browser"],
      format: "esm",
      metafile: true,
      platform: "browser",
      write: false,
    });

    expect(result.errors).toEqual([]);
    expect(Object.keys(result.metafile.inputs)).not.toContain(
      "packages/shared/src/index.ts",
    );
    const importedPaths = Object.values(result.metafile.inputs).flatMap(
      (input) => input.imports.map((entry) => entry.path),
    );
    expect(importedPaths.some((path) => path.startsWith("node:"))).toBe(false);
  }, 120_000);
});
