/**
 * E2E config for apps/app — delegates to the root vitest.e2e.config.ts.
 * This file exists because vitest auto-discovers workspace projects and
 * expects a matching config variant when --config vitest.e2e.config.ts
 * is passed at the root level.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [],
  },
});
