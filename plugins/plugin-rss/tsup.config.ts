import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  sourcemap: true,
  clean: false,
  format: ["esm"],
  dts: true,
  external: [
    "dotenv",
    "fs",
    "path",
    "https",
    "http",
    "@elizaos/core",
  ],
});

