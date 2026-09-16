/** Vitest config for the unit suite — aliases sibling plugin and package `src` dirs so tests resolve them from source. */
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/scripts/vitest/default.config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases.ts";

export default defineConfig({
  resolve: {
    ...baseConfig.resolve,
    alias: buildWorkspaceSourceAliases(),
  },
  test: {
    environment: "node",
    include: [
      "__tests__/**/*.test.ts",
      "__tests__/**/*.test.tsx",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "src/__tests__/**/*.test.ts",
      "src/__tests__/**/*.test.tsx",
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
