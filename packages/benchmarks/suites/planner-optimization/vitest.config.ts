import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import runner from "../../../testing/scenario-runner/vitest.config.ts";
export default defineConfig({
  ...runner,
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: { ...runner.test, include: ["src/**/*.test.ts"], maxWorkers: 1 },
});
