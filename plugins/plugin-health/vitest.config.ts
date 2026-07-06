/**
 * Vitest configuration for plugin-health tests, provider SDK shims, and sibling
 * scheduling source aliases.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import {
  providerSdkAliases,
  providerSdkShimPlugin,
} from "../../packages/test/vitest/provider-sdk-aliases";

// Cross-plugin gate coverage must exercise sibling source, not stale dist.
const aliases = {
  ...providerSdkAliases,
  "@elizaos/shared": fileURLToPath(
    new URL("../../packages/shared/src/index.ts", import.meta.url),
  ),
  "@elizaos/tui": fileURLToPath(
    new URL("../../packages/tui/src/index.ts", import.meta.url),
  ),
  "@elizaos/plugin-scheduling": fileURLToPath(
    new URL("../plugin-scheduling/src/index.ts", import.meta.url),
  ),
};

export default defineConfig({
  plugins: [providerSdkShimPlugin()],
  resolve: {
    alias: aliases,
  },
  test: {
    alias: aliases,
    // Pin local-day helpers so screen-time assertions match across dev and CI.
    env: { TZ: "America/Los_Angeles" },
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "**/*.live.test.ts",
      "**/*.e2e.test.ts",
    ],
  },
});
