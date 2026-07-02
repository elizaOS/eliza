import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [
      "dist/**",
      "node_modules/**",
      // #9310 §E: the guarded *.live.test.ts suite (self-skips keyless) is
      // invocable only in the post-merge lane, where run-all-tests.mjs
      // prints a named skip accounting.
      ...(process.env.VITEST_LANE === "post-merge"
        ? []
        : ["src/**/*.live.test.ts", "test/**/*.live.test.ts"]),
    ],
  },
});
