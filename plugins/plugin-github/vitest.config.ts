/**
 * Vitest config for the plugin. Applies the repo's shared provider-SDK
 * aliases/shims (via `providerSdkShimPlugin`) and runs the plugin's `src`
 * test files in a node environment.
 */

import path from "node:path";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";
import {
  providerSdkAliases,
  providerSdkShimPlugin,
} from "../../packages/test/vitest/provider-sdk-aliases";

const baseResolveAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];
const baseTestAliases = Array.isArray(baseConfig.test?.alias)
  ? baseConfig.test.alias
  : [];

export default defineConfig({
  ...baseConfig,
  plugins: [...(baseConfig.plugins ?? []), providerSdkShimPlugin()],
  resolve: {
    ...baseConfig.resolve,
    alias: [...providerSdkAliases, ...baseResolveAliases],
  },
  test: {
    ...baseConfig.test,
    alias: [...providerSdkAliases, ...baseTestAliases],
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    root: path.resolve(__dirname),
  },
});
