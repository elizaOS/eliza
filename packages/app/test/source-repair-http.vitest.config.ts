import { defineConfig } from "vitest/config";
import config from "../vitest.config.ts";
export default defineConfig({
  ...config,
  test: {
    ...config.test,
    environment: "node",
    setupFiles: [],
    include: ["test/source-repair-http.e2e.test.ts"],
    exclude: [],
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
