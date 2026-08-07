/**
 * Keeps the package's Vitest unit lane separate from the Node-native browser
 * capture proof, which is exercised through the dedicated `test:e2e` script.
 */
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "scripts/headless-capture-e2e.test.mjs",
    ],
  },
});
