/**
 * Default unit-test config: runs `__tests__/**\/*.test.ts`, excluding the
 * PGLite-backed `*.harness.test.ts` suite (see `vitest.harness.config.ts`) and
 * the live `*.live.test.ts` suite outside the post-merge lane.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    // `*.harness.test.ts` boot a real PGLite runtime and need the workspace
    // source aliases from vitest.harness.config.ts — run via `test:harness`.
    exclude: [
      "dist/**",
      "node_modules/**",
      // #9310 §E: the guarded *.live.test.ts suite (self-skips keyless) is
      // invocable only in the post-merge lane, where run-all-tests.mjs
      // prints a named skip accounting.
      ...(process.env.VITEST_LANE === "post-merge"
        ? []
        : ["**/*.live.test.ts"]),
      "**/*.harness.test.ts",
    ],
  },
});
