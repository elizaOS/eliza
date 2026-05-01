import { defineConfig } from "vitest/config";

const unitExcludes = [
  "dist/**",
  "**/node_modules/**",
  "**/*.live.test.{ts,tsx}",
  "**/*.live.e2e.test.{ts,tsx}",
  "**/*.real.test.{ts,tsx}",
  "**/*.real.e2e.test.{ts,tsx}",
  "**/*.integration.test.{ts,tsx}",
  "**/*.e2e.test.{ts,tsx}",
  "**/*.e2e.spec.{ts,tsx}",
];

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: unitExcludes,
    globals: false,
    testTimeout: 30000,
  },
});
