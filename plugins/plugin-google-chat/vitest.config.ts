/** Vitest config for the Google Chat connector; aliases provider SDKs to shims and excludes live/e2e suites so unit tests run offline. */
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
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts", "test/format-error.test.ts"],
    exclude: ["dist/**", "**/node_modules/**", "**/*.live.test.ts", "**/*.e2e.test.ts"],
  },
});
