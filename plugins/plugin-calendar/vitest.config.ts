import { defineConfig } from "vitest/config";

/**
 * Unit-test config. UI / service suites that need inlined core/agent/ui or
 * plugin-google stubs are layered in alongside their specs; the base here keeps
 * node-environment domain tests fast.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}", "test/**/*.{test,spec}.{ts,tsx}"],
    exclude: [
      "node_modules/**",
      "dist/**",
      "**/*.e2e.test.{ts,tsx}",
      "**/*.real.test.{ts,tsx}",
      "**/*.live.test.{ts,tsx}",
    ],
    passWithNoTests: true,
  },
});
