/**
 * Vitest config for plugin-wallet-ui. Forces a single React/ReactDOM copy via
 * explicit aliases (avoids duplicate-React errors across workspace packages),
 * collapses `@elizaos/ui/<subpath>` imports to the single built `@elizaos/ui`
 * package so subpath resolution doesn't depend on the ui package's dist
 * layout, and redirects a plugin-health subpath import to source since that
 * package publishes no matching subpath export.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const elizaRoot = path.resolve(here, "../..");
const require = createRequire(import.meta.url);

export default defineConfig({
  root: here,
  resolve: {
    alias: [
      {
        find: /^react$/,
        replacement: path.dirname(require.resolve("react/package.json")),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: require.resolve("react/jsx-runtime"),
      },
      {
        find: /^react-dom$/,
        replacement: path.dirname(require.resolve("react-dom/package.json")),
      },
      {
        find: /^react-dom\/client$/,
        replacement: require.resolve("react-dom/client"),
      },
      {
        find: /^@elizaos\/ui\/(agent-surface|api|components(?:\/.*)?|hooks|layouts|state|utils)$/,
        replacement: "@elizaos/ui",
      },
      {
        find: /^@elizaos\/plugin-health\/screen-time\/mobile-signal-setup$/,
        replacement: path.resolve(
          elizaRoot,
          "plugins/plugin-health/src/screen-time/mobile-signal-setup.ts",
        ),
      },
    ],
  },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
  },
});
