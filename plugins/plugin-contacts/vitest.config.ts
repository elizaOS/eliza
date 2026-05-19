import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^react$/,
        replacement: dirname(require.resolve("react/package.json")),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: require.resolve("react/jsx-runtime"),
      },
      {
        find: /^react-dom$/,
        replacement: dirname(require.resolve("react-dom/package.json")),
      },
      {
        find: /^react-dom\/client$/,
        replacement: require.resolve("react-dom/client"),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: resolve(rootDir, "test/stubs/ui.tsx"),
      },
      {
        find: /^@elizaos\/ui\/platform$/,
        replacement: resolve(rootDir, "test/stubs/ui-platform.ts"),
      },
      {
        find: /^@elizaos\/capacitor-contacts$/,
        replacement: resolve(
          rootDir,
          "../../plugins/plugin-native-contacts/src/index.ts",
        ),
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
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    passWithNoTests: true,
    environment: "node",
  },
});
