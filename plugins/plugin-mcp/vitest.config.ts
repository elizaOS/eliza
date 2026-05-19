import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    globals: true,
    environment: "node",
  },
});
