import { defineConfig } from "vitest/config";
import {
  providerSdkAliases,
  providerSdkShimPlugin,
} from "../../test/vitest/provider-sdk-aliases";

export default defineConfig({
  plugins: [providerSdkShimPlugin()],
  resolve: {
    alias: providerSdkAliases,
  },
  test: {
    alias: providerSdkAliases,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "**/*.live.test.ts",
      "**/*.e2e.test.ts",
    ],
  },
});
