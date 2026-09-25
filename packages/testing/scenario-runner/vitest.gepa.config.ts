/** Explicit genuine-engine lane; dependencies are prepared separately. */
import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["gepa/**/*.test.ts"],
    testTimeout: 240_000,
    maxWorkers: 1,
  },
});
