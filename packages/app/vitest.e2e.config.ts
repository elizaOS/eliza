/**
 * Minimal E2E config for packages/app workspace resolution.
 * Monorepo e2e lives under `packages/scripts/vitest/e2e.config.ts` (run with
 * `--config packages/scripts/vitest/e2e.config.ts` from the repo root).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [],
  },
});
