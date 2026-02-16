import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["typescript/src/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "dist/**",
      "**/*.live.test.ts",
      "**/*.e2e.test.ts",
    ],
  },
});
