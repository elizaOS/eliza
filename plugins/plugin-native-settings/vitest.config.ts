/**
 * Aliases `@elizaos/capacitor-system` to its real `src/index.ts` (not a
 * mock) so `device-settings-contract.test.ts` exercises the actual
 * `SystemWeb` fallback the view depends on, catching drift between the
 * view's parsing assumptions and the provider's real output shape.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/capacitor-system": resolve(
        rootDir,
        "../../plugins/plugin-native-system/src/index.ts",
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
  },
});
