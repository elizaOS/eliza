import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  tsconfig: "./tsconfig.build.json", // Use build-specific tsconfig
  sourcemap: true,
  clean: true,
  format: ["esm"],
  dts: true,
  external: ["@elizaos/core", "@elizaos/plugin-local-inference"],
});
