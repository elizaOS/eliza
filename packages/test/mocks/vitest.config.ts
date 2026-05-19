import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/mocks/__tests__/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    forks: { singleFork: true },
  },
});
