import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["eliza-source", "module", "browser", "development|production"],
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
