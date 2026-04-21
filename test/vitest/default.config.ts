import { defineConfig } from "vitest/config";

// Default vitest configuration shared by package-level vitest.config.ts files
// across the monorepo. Callers spread this as `...baseConfig` and then override
// `test.include`, `setupFiles`, etc. Keep this minimal — per-package configs
// carry their own project-specific overrides.
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    isolate: true,
  },
});
