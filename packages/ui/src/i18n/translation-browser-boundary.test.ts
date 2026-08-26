/** Proves the renderer translation hook stays browser-bundleable without Node built-ins. */
import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("translation browser boundary", () => {
  it("bundles the real translation hook for a browser target", async () => {
    const result = await build({
      entryPoints: [
        path.resolve(process.cwd(), "src/state/TranslationContext.hooks.ts"),
      ],
      bundle: true,
      conditions: ["eliza-source", "browser"],
      external: ["react"],
      format: "esm",
      platform: "browser",
      write: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.outputFiles).toHaveLength(1);
  });
});
