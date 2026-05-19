import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      react: resolve(rootDir, "../../node_modules/react"),
      "react/jsx-runtime": resolve(
        rootDir,
        "../../node_modules/react/jsx-runtime.js",
      ),
      "react-dom": resolve(rootDir, "../../node_modules/react-dom"),
      "@elizaos/capacitor-phone": resolve(
        rootDir,
        "../../plugins/plugin-native-phone/src/index.ts",
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    passWithNoTests: true,
    environment: "node",
  },
});
