/**
 * Standalone Vitest config for the root plugin contract suite.
 *
 * These tests parse plugin setup-route source files as text without importing
 * plugin code, so the config stays minimal and independent of the wider test
 * harness.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  test: {
    dir: __dirname,
    include: ["**/*.test.ts"],
    root: __dirname,
    passWithNoTests: false,
    testTimeout: 10_000,
  },
});
