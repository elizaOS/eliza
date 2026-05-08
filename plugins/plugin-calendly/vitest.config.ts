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
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["node_modules/**", "dist/**"],
    passWithNoTests: true,
  },
});
