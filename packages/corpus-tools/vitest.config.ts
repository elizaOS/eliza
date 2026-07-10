/**
 * Vitest config for @elizaos/corpus-tools: deterministic unit coverage over
 * synthetic JSONL fixtures, schema validation, and mock-shape mappers.
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
