/** Vitest config for plugin-x, wiring the shared provider-SDK aliases/shim so tests run without real provider SDKs installed. */
import { defineConfig } from "vitest/config";
import {
  providerSdkAliases,
  providerSdkShimPlugin,
  repoRoot,
} from "../../packages/test/vitest/provider-sdk-aliases";

const testAliases = [
  {
    find: "@elizaos/core/node",
    replacement: `${repoRoot}/core/src/index.node.ts`,
  },
  ...providerSdkAliases,
  {
    find: "@elizaos/logger",
    replacement: `${repoRoot}/logger/src/index.ts`,
  },
];

export default defineConfig({
  plugins: [providerSdkShimPlugin()],
  resolve: {
    alias: testAliases,
  },
  test: {
    alias: testAliases,
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
