/**
 * Vitest configuration for deterministic synthetic-world contract tests.
 */
import { defineConfig, mergeConfig } from "vitest/config";
import rootConfig from "../../vitest.config.ts";

export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
      exclude: ["**/node_modules/**"],
    },
  }),
);
