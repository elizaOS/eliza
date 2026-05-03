import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../test/vitest/default.config";

// E2E tests need the real developer environment (real $HOME so the external
// scanner finds real LM Studio / Ollama / Jan caches; real network access;
// real disk). The default test setup isolates HOME to a temp dir. Opting
// into LIVE=1 before it runs keeps the real values.
process.env.LIVE = "1";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * E2E-only vitest config. Separate from `vitest.config.ts` because the
 * default run excludes `*.e2e.test.ts` (they're slow, load real GGUFs,
 * run real native code). Invoke via `bunx vitest run --config vitest.e2e.config.ts`.
 */
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    setupFiles: [path.join(here, "test/setup.ts")],
    include: ["src/**/*.e2e.test.ts", "src/**/*.e2e.test.tsx"],
    exclude: ["dist/**", "**/node_modules/**"],
    testTimeout: 600_000,
    hookTimeout: 60_000,
  },
});
