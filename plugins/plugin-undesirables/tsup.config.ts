import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  sourcemap: true,
  clean: true,
  format: ["esm"],
  dts: true,
  external: ["@elizaos/core", "fs", "path", "js-yaml"],
});
