import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./__tests__/setup.ts"],
    include: ["__tests__/**/*.test.ts", "src/__tests__/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
