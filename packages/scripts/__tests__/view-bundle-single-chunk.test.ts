/** Verifies that the shared plugin-view configuration emits one module. */
import { describe, expect, test } from "bun:test";
import { createViewBundleConfig } from "../view-bundle-vite.config.ts";

// The Rollup and Rolldown output fields this config controls. Typed narrowly
// instead of importing either bundler's `OutputOptions`.
type ViewBundleOutput = {
  codeSplitting?: boolean;
  exports?: string;
  inlineDynamicImports?: boolean;
};

// Regression for #11040 / #10830: the cockpit terminal pane rendered blank
// because a plugin view bundle was code-split. Rolldown emitted a lazy chunk
// that re-imported "./bundle.js" WITHOUT the ?hostExternalRuntime query the
// shell's DynamicViewLoader loaded the entry with. The browser then fetched
// the raw bundle as a second module whose bare externals ("@elizaos/ui",
// "react") could not resolve — killing the whole lazy graph, including
// PtyTerminalPane's xterm import.
//
// The shared config sets both `output.codeSplitting: false` for Rolldown and
// `output.inlineDynamicImports: true` for Rollup so every view is one
// self-contained bundle.js under either Vite build path.

function outputOf(
  opts?: Parameters<typeof createViewBundleConfig>[0],
): ViewBundleOutput {
  const cfg = createViewBundleConfig(
    opts ?? {
      packageName: "@elizaos/plugin-example",
      viewId: "example-view",
      entry: "./src/views/example-view-bundle.ts",
    },
  );
  const output = cfg.build?.rollupOptions?.output;
  expect(output).toBeDefined();
  expect(Array.isArray(output)).toBe(false);
  return output as ViewBundleOutput;
}

describe("view-bundle Vite config: single self-contained bundle", () => {
  test("disables code splitting so no lazy chunk re-imports ./bundle.js", () => {
    const output = outputOf();
    // Must be explicitly false — `undefined` lets rolldown fall back to
    // code-splitting, which reintroduces the blank-terminal bug.
    expect(output.codeSplitting).toBe(false);
    expect(output.inlineDynamicImports).toBe(true);
  });

  test("emits exactly one ES module named bundle.js with named exports", () => {
    const cfg = createViewBundleConfig({
      packageName: "@elizaos/plugin-example",
      viewId: "example-view",
      entry: "./src/views/example-view-bundle.ts",
    });
    const lib = cfg.build?.lib as {
      formats?: string[];
      fileName?: (format: string, entryName: string) => string;
    };
    expect(lib?.formats).toEqual(["es"]);
    expect(typeof lib?.fileName).toBe("function");
    expect(lib?.fileName?.("es", "example")).toBe("bundle.js");
    expect(outputOf().exports).toBe("named");
  });

  test("keeps code splitting off regardless of caller options", () => {
    for (const additionalExternals of [[], ["three"], ["@elizaos/plugin-x"]]) {
      const output = outputOf({
        packageName: "@elizaos/plugin-x",
        viewId: "x",
        entry: "./src/x.ts",
        outDir: "dist/custom",
        componentExport: "XView",
        additionalExternals,
      });
      expect(output.codeSplitting).toBe(false);
      expect(output.inlineDynamicImports).toBe(true);
    }
  });
});
