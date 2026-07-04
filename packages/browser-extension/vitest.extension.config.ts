/**
 * Vitest config for the extension's src/ unit tests; loads the jsdom DOM shim
 * (test-dom-setup) so DOM-dependent modules run under Node.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/test-dom-setup.ts"],
  },
});
