import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 90_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    maxWorkers: 1,
    sequence: {
      concurrent: false,
    },
  },
});
