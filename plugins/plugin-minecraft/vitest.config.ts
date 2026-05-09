import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
    passWithNoTests: true,
    environment: "node",
  },
});
