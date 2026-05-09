import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  tsconfig: "./tsconfig.build.json",
  sourcemap: true,
  clean: true,
  format: ["esm"],
  // The tsup DTS plugin still emits deprecated TS 6 baseUrl options internally.
  // This package does not publish a types entry, so keep the build JS-only.
  dts: false,
  external: ["dotenv", "fs", "path"],
});
