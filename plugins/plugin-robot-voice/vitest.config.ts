import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/__tests__/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**", "**/*.e2e.test.ts", "**/*.live.test.ts"],
  },
});
