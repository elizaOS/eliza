/**
 * Vitest config for real-engine browser workspace lanes.
 *
 * It opts `*.real.test.ts` files back into execution while keeping root
 * workspace aliases and long timeouts for Chromium-backed runs.
 */
import { defineConfig } from "vitest/config";
import baseConfig from "../../vitest.config.ts";

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
