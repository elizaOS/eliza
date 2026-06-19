import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Standalone vitest config for the plugins/__tests__ contract suite.
 *
 * These tests parse plugin setup-route source files as text — no plugin
 * code is actually imported or executed — so the config can stay minimal
 * and independent of the wider eliza test harness.
 */
export default defineConfig({
  test: {
    dir: __dirname,
    include: ["**/*.test.ts"],
    root: __dirname,
    passWithNoTests: false,
    testTimeout: 10_000,
  },
});
