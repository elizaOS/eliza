import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const testingLibraryRequire = createRequire(
  require.resolve("@testing-library/react/package.json"),
);
const reactRoot = dirname(testingLibraryRequire.resolve("react/package.json"));
const reactDomRoot = dirname(
  testingLibraryRequire.resolve("react-dom/package.json"),
);

export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      {
        find: /^react$/,
        replacement: reactRoot,
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: testingLibraryRequire.resolve("react/jsx-runtime"),
      },
      {
        find: /^react-dom$/,
        replacement: reactDomRoot,
      },
      {
        find: /^react-dom\/client$/,
        replacement: testingLibraryRequire.resolve("react-dom/client"),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: resolve(rootDir, "test/stubs/ui.tsx"),
      },
      {
        find: /^@elizaos\/ui\/components\/ui\/tabs$/,
        replacement: resolve(rootDir, "test/stubs/ui-tabs.tsx"),
      },
      {
        find: /^@elizaos\/ui\/app-shell-registry$/,
        replacement: resolve(rootDir, "test/stubs/ui.tsx"),
      },
      {
        find: /^@elizaos\/capacitor-phone$/,
        replacement: resolve(
          rootDir,
          "../../plugins/plugin-native-phone/src/index.ts",
        ),
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
