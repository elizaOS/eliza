/**
 * Runs the plugin's source tests against the real workspace package graph.
 */

import path from "node:path";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/scripts/vitest/default.config";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    root: path.resolve(__dirname),
  },
});
