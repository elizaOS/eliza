import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [
      "dist/**",
      "node_modules/**",
      "src/**/*.live.test.ts",
      "test/**/*.live.test.ts",
    ],
  },
});
