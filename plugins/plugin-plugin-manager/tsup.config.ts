import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  tsconfig: "./tsconfig.build.json", // Use build-specific tsconfig
  sourcemap: true,
  clean: true,
  format: ["esm"], // Ensure you're targeting CommonJS
  dts: process.platform !== "win32", // Windows tsup DTS is flaky; tsc emits declarations below.
  external: [
    "dotenv", // Externalize dotenv to prevent bundling
    "fs", // Externalize fs to use Node.js built-in module
    "fs-extra", // Externalize fs-extra to prevent bundling issues
    "path", // Externalize other built-ins if necessary
    "https",
    "http",
    "@elizaos/core",
    "zod",
  ],
});
