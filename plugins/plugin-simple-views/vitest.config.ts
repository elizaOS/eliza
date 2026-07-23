/** Runs Simple Views domain tests in Node and component tests in jsdom. */
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    root: import.meta.dirname,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    environment: "jsdom",
  },
});
