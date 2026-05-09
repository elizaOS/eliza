import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  tsconfig: "./tsconfig.build.json",
  sourcemap: true,
  clean: true,
  format: ["esm"],
  // Upstream sources are not strict against current @elizaos/core types; ship JS only.
  dts: true,
  external: ["dotenv", "fs", "path"],
});
