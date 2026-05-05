import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/capacitor-phone": resolve(
        rootDir,
        "../../packages/native-plugins/phone/src/index.ts",
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    passWithNoTests: true,
    environment: "node",
  },
});
