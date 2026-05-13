/**
 * Vitest config for tests that require node:sqlite (Node ≥22.5, stable in
 * Node ≥24). Extends the main vitest.config.ts but removes the node:sqlite
 * exclude so CI can run training-benchmarks.test.ts under Node explicitly.
 *
 * Bun does not expose node:sqlite, so this config is meant for Node only.
 * CI usage (test.yml — "Run node:sqlite tests" step):
 *   node node_modules/vitest/vitest.mjs run --config vitest.node-sqlite.config.ts
 */
import base from "./vitest.config.ts";

// mergeConfig concatenates arrays (include, exclude) rather than replacing
// them, so the training-benchmarks.test.ts file would end up in both include
// and exclude — and exclude wins, leaving no test files. Use object spread
// to replace the arrays instead of appending to them.
export default {
  ...base,
  test: {
    ...base.test,
    include: ["src/api/training-benchmarks.test.ts"],
    exclude: ((base.test?.exclude ?? []) as unknown[]).filter(
      (p: unknown) =>
        typeof p !== "string" || !p.includes("training-benchmarks"),
    ),
  },
};
