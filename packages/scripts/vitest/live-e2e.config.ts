/** Configures the live e2e shared Vitest lane used by workspace package tests. */
import { defineConfig } from "vitest/config";
import { liveAndRealE2EInclude, nonVitestE2EExcludedPaths } from "./e2e.config";
import baseConfig from "./real.config";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: liveAndRealE2EInclude,
    exclude: [
      ...(baseConfig.test?.exclude ?? []),
      ...nonVitestE2EExcludedPaths,
    ],
  },
});
