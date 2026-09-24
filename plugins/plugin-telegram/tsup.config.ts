/**
 * Builds the public ESM root, including the GramJS account-auth service.
 * Type declarations are emitted
 * separately by `tsc` in the build script (`dts: false`); Node built-ins and
 * heavy optional deps are left external.
 */
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  tsconfig: "./tsconfig.build.json",
  sourcemap: true,
  clean: true,
  format: ["esm"],
  dts: false,
  external: [
    "dotenv",
    "fs",
    "path",
    "@reflink/reflink",
    "@node-llama-cpp",
    "https",
    "http",
    "agentkeepalive",
    "zod",
  ],
});
