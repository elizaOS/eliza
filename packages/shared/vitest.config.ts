/** Vitest config for @elizaos/shared, extending the repo default config rooted at this package. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const realTestExcludes = new Set([
  "**/*-real.test.{ts,tsx}",
  "**/*.real.test.{ts,tsx}",
]);
const realLaneRequested =
  process.env.VITEST_EXCLUDE_REAL !== "1" &&
  (process.env.TEST_LANE === "post-merge" ||
    process.env.VITEST_LANE === "post-merge");
const inheritedExcludes = baseConfig.test?.exclude ?? [];

export default defineConfig({
  ...baseConfig,
  root: here,
  test: {
    ...baseConfig.test,
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "__tests__/**/*.test.{ts,tsx}"],
    exclude: realLaneRequested
      ? inheritedExcludes.filter((pattern) => !realTestExcludes.has(pattern))
      : inheritedExcludes,
  },
});
