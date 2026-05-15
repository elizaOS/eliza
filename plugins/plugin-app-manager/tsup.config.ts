import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  sourcemap: true,
  dts: true,
  clean: true,
  format: ["esm"],
  external: [
    "dotenv",
    "fs",
    "path",
    "child_process",
    "@elizaos/core",
    // Phase 4G: app-manager routes/services depend on @elizaos/agent for
    // config helpers (paths, feature-flags, eliza config) and sibling
    // runtime services (overlay presence, registry client, plugin types,
    // app-package modules, app-manager-agents-list-guard, atomic-json).
    // The agent loads us at runtime; we must not bundle it.
    "@elizaos/agent",
    "@elizaos/shared",
  ],
});
