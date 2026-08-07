/** Vitest config for Contacts: layers native/UI test seams over the shared workspace source aliases. */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/scripts/vitest/default.config";

const rootDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];

export default defineConfig({
  resolve: {
    ...baseConfig.resolve,
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
        find: /^@elizaos\/capacitor-contacts\/web$/,
        replacement: resolve(
          rootDir,
          "../../plugins/plugin-native-contacts/src/web.ts",
        ),
      },
      {
        find: /^@elizaos\/capacitor-contacts$/,
        replacement: resolve(
          rootDir,
          "../../plugins/plugin-native-contacts/src/index.ts",
        ),
      },
      {
        // @elizaos/ui's DynamicViewLoader statically imports this plugin-health
        // subpath; the keyless contacts test env has no built plugin-health
        // dist to resolve it against, so collection of every Contacts view test
        // fails. Anchor it to source, matching plugin-phone and wallet-ui.
        find: /^@elizaos\/plugin-health\/screen-time\/mobile-signal-setup$/,
        replacement: resolve(
          rootDir,
          "../../plugins/plugin-health/src/screen-time/mobile-signal-setup.ts",
        ),
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
      ...baseAliases,
    ],
  },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
  },
});
