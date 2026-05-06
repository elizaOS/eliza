import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
    passWithNoTests: true,
  },
});
