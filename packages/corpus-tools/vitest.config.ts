/**
 * Vitest config for @elizaos/corpus-tools: deterministic unit coverage over
 * synthetic JSONL fixtures, schema validation, and mock-shape mappers.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
