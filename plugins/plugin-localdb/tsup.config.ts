/** tsup build config: dual-entry JavaScript build (Node `index.ts` + browser `index.browser.ts`), ESM only. */
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "index.ts",
    "index.browser": "index.browser.ts",
  },
  format: ["esm"],
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  external: ["@elizaos/core", "@elizaos/plugin-inmemorydb"],
});
