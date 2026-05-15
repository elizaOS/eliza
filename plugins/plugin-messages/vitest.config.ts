import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/capacitor-messages": resolve(
        rootDir,
        "../../packages/native-plugins/messages/src/index.ts",
      ),
      "@elizaos/capacitor-system": resolve(
        rootDir,
        "../../packages/native-plugins/system/src/index.ts",
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    passWithNoTests: true,
    environment: "node",
  },
});
