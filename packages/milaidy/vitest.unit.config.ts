import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const baseTest = (baseConfig as { test?: { include?: string[]; exclude?: string[] } }).test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    include: baseTest.include ?? ["src/**/*.test.ts", "test/format-error.test.ts"],
    exclude: baseTest.exclude ?? [],
  },
});
