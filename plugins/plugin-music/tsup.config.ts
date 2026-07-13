/**
 * Build configuration for publishing the music plugin as an ESM package with
 * JavaScript output. TypeScript's native compiler emits declarations in the
 * package build script.
 */
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  tsconfig: "./tsconfig.build.json",
  sourcemap: true,
  clean: true,
  format: ["esm"],
  external: ["dotenv", "fs", "path"],
});
