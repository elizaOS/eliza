import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/account-auth-service.ts"],
  outDir: "dist",
  tsconfig: "./tsconfig.build.json", // Use build-specific tsconfig
  sourcemap: true,
  clean: true,
  format: ["esm"], // Ensure you're targeting CommonJS
  dts: true, // generate .d.ts so consumers get proper types
  external: [
    "dotenv", // Externalize dotenv to prevent bundling
    "fs", // Externalize fs to use Node.js built-in module
    "path", // Externalize other built-ins if necessary
    "@reflink/reflink",
    "@node-llama-cpp",
    "https",
    "http",
    "agentkeepalive",
    "zod",
  ],
});
