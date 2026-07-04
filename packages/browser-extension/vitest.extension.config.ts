/**
 * Vitest config for browser-extension unit tests.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/test-dom-setup.ts"],
  },
});
