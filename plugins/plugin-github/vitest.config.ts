/**
 * Vitest config for the plugin. Applies the repo's shared provider-SDK
 * aliases/shims (via `providerSdkShimPlugin`) and runs the plugin's `src`
 * test files in a node environment.
 */

import path from "node:path";
import { defineConfig } from "vitest/config";
import {
  providerSdkAliases,
  providerSdkShimPlugin,
} from "../../packages/test/vitest/provider-sdk-aliases";

export default defineConfig({
  plugins: [providerSdkShimPlugin()],
  resolve: {
    alias: providerSdkAliases,
  },
  test: {
    alias: providerSdkAliases,
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    root: path.resolve(__dirname),
  },
});
