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
    include: ["__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
    passWithNoTests: true,
    environment: "node",
  },
});
