/**
 * Vitest config for the plugin: aliases the Neynar/provider SDKs to shims so
 * the suite runs offline without real network SDK dependencies.
 */
import { defineConfig } from "vitest/config";
import {
  providerSdkAliases,
  providerSdkShimPlugin,
} from "../../packages/test/vitest/provider-sdk-aliases";

export default defineConfig({
  resolve: {
    alias: providerSdkAliases,
  },
  plugins: [providerSdkShimPlugin()],
  test: {
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
  },
});
