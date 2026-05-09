import path from "node:path";
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
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    root: path.resolve(__dirname),
  },
});
