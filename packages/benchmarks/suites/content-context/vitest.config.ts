import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import testingConfig from "../../../testing/vitest.config.ts";
export default mergeConfig(
  testingConfig,
  defineConfig({
    root: fileURLToPath(new URL(".", import.meta.url)),
    test: { include: ["**/*.test.ts"], testTimeout: 180_000, maxWorkers: 1 },
  }),
);
