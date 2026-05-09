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
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
