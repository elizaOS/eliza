import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";
export default defineConfig({
  ...base,
  test: { ...base.test, include: ["gepa/**/*.test.ts"], testTimeout: 360_000 },
});
