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
    globals: true,
    environment: "node",
    include: [
      "__tests__/**/*.test.ts",
      "src/**/__tests__/**/*.test.ts",
      "src/**/*.test.ts",
    ],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
