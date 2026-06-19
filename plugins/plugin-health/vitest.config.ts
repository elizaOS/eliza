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
    // screen-time range helpers compute from the machine-local start of day;
    // pin the zone so these assertions are deterministic across dev + CI.
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
