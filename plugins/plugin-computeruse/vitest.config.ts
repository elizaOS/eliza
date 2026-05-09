import { defineConfig } from "vitest/config";

const liveOnlyExcludes = [
  "**/*.live.test.{ts,tsx}",
  "**/*.live.e2e.test.{ts,tsx}",
  "**/*.real.test.{ts,tsx}",
  "**/*.real.e2e.test.{ts,tsx}",
  "**/*.e2e.test.{ts,tsx}",
  "**/*.e2e.spec.{ts,tsx}",
];

export default defineConfig({
  test: {
    testTimeout: 90_000,
    hookTimeout: 30_000,
    environment: "node",
    exclude: liveOnlyExcludes,
    fileParallelism: false,
    maxWorkers: 1,
    sequence: {
      concurrent: false,
    },
  },
});
