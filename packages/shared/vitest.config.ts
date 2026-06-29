import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  ...baseConfig,
  root: here,
  test: {
    ...baseConfig.test,
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "__tests__/**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "**/node_modules/**"],
    // Coverage floor — established at a conservative 1% to wire the mechanism
    // (issue #9943). Inert in normal CI: run-vitest.mjs never passes --coverage,
    // so thresholds only evaluate when a run explicitly opts in, at which point a
    // full-suite run clears 1% trivially. Raise toward the measured baseline as a
    // follow-up; see .github/workflows/coverage-gate.yml.
    coverage: {
      thresholds: {
        lines: 1,
        functions: 1,
        branches: 1,
        statements: 1,
      },
    },
  },
});
