/**
 * Vitest configuration for browser plugin real-Chromium lanes.
 */

import { defineConfig } from "vitest/config";
import baseConfig from "../../vitest.config.ts";

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
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 120_000,
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
