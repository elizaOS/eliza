import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["typescript/__tests__/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
      include: ["typescript/**/*.ts"],
      exclude: ["typescript/__tests__/**"],
    },
  },
});
