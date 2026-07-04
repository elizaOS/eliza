/** tsup build config: dual-entry build (Node `index.ts` + browser `index.browser.ts`), ESM only, with declaration output. */
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
  dts: true,
  outDir: "dist",
  external: ["@elizaos/core", "@elizaos/plugin-inmemorydb"],
});
