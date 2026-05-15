import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 30_000,
    include: ["__tests__/**/*.test.ts"],
    reporters: ["verbose"],
  },
});
