/**
 * tsup build config for the plugin's two ESM entry points (`index.ts` and the
 * standalone GramJS `account-auth-service.ts`). Type declarations are emitted
 * separately by `tsc` in the build script (`dts: false`); Node built-ins and
 * heavy optional deps are left external.
 */
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/account-auth-service.ts"],
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
