import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/*.live.e2e.test.ts"],
    testTimeout: 420_000,
    hookTimeout: 60_000,
  },
});
