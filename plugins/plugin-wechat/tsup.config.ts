/** tsup build config for the WeChat plugin: ESM bundle from src/index.ts to dist/. */
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "es2022",
  sourcemap: true,
  clean: true,
  splitting: false,
  external: [/^@elizaos\//],
});
