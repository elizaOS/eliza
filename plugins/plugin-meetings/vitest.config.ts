/**
 * Keeps the package's Vitest unit lane separate from the Node-native browser
 * capture proof, which is exercised through the dedicated `test:e2e` script.
 * Workspace dependencies resolve from source so standalone tests cannot exercise
 * stale build output.
 */
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";


export default defineConfig({
  resolve: {
    alias: [
    ],
  },
  test: {
    exclude: [...configDefaults.exclude],
  },
});
