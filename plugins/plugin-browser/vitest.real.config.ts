import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../vitest.config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Dedicated config for the real-engine lanes (#10333). The root
 * `vitest.config.ts` excludes `**\/*.real.test.ts` so they stay out of the
 * default `vitest run`; this config opts them back in (without re-adding that
 * exclusion — `mergeConfig` would concatenate it back) while keeping the root's
 * `@elizaos/*` → source aliases so plugin-browser resolves its workspace deps.
 *
 * Run via: `bunx vitest run --config plugins/plugin-browser/vitest.real.config.ts`
 * (or the `test:real-chromium` package script). The lanes still self-skip when
 * no Chromium binary is installed, so this is only meaningful after
 * `bunx playwright install --with-deps chromium`.
 */
export default defineConfig({
  resolve: baseConfig.resolve,
  test: {
    // Pin the root to this package so `src/**` resolves regardless of the cwd
    // the runner is invoked from (the package script runs from here; CI runs
    // from the repo root with `--config <this file>`).
    root: here,
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 120_000,
    // Each real lane drives its own Chromium; running test files in parallel
    // workers launches multiple browsers at once and starves them on a loaded
    // box. Run the lanes one at a time.
    fileParallelism: false,
    include: ["src/**/*.real.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.git/**",
      "**/.claude/**",
    ],
  },
});
