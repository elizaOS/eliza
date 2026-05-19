import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@elizaos/capacitor-phone",
        replacement: resolve(
          rootDir,
          "../../plugins/plugin-native-phone/src/index.ts",
        ),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: resolve(rootDir, "../../packages/ui/src/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: resolve(rootDir, "../../packages/ui/src/$1"),
      },
      {
        find: /^@elizaos\/app-core$/,
        replacement: resolve(rootDir, "../../packages/app-core/src/index.ts"),
      },
      {
        find: /^@elizaos\/app-core\/(.+)$/,
        replacement: resolve(rootDir, "../../packages/app-core/src/$1"),
      },
    ],
  },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    passWithNoTests: true,
    environment: "node",
  },
});
