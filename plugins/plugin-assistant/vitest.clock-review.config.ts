import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/clock-review-export.integration.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
