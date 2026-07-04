/** Vitest config for the Instagram plugin; aliases provider SDKs to test shims. */
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
    include: ["__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
  },
});
