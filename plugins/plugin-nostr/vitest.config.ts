import { defineConfig } from "vitest/config";
import {
  providerSdkAliases,
  providerSdkShimPlugin,
} from "../../test/vitest/provider-sdk-aliases";

export default defineConfig({
  resolve: {
    alias: providerSdkAliases,
  },
  plugins: [providerSdkShimPlugin()],
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    passWithNoTests: true,
  },
});
