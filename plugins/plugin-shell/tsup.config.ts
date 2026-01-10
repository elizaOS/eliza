import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  tsconfig: './tsconfig.build.json', // Use build-specific tsconfig
  sourcemap: true,
  clean: true,
  format: ["esm"],
  external: ["@elizaos/core", "cross-spawn", "joi", "path", "fs", "child_process", "os"],
  dts: true,
}); 