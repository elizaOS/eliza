/**
 * Vitest config for plugin-wallet-ui. Forces a single React/ReactDOM copy via
 * explicit aliases (avoids duplicate-React errors across workspace packages),
 * collapses `@elizaos/ui` and every `@elizaos/ui/<subpath>` import onto the ui
 * package's SOURCE entry, and redirects a plugin-health subpath import to source
 * since that package publishes no matching subpath export.
 *
 * The ui alias targets `packages/ui/src/index.ts`, not the package's `.` export,
 * so the suite can run before workspace build artifacts exist. The wallet gui
 * test fully `vi.mock`s `@elizaos/ui`, so the source file is only resolved (to
 * key the mock), never loaded; aliasing to a source path lets the mock register
 * under both the bare and every subpath specifier.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const elizaRoot = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const uiSource = path.resolve(elizaRoot, "packages/ui/src/index.ts");

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
        find: /^@elizaos\/ui\/(agent-surface|api|bridge|components(?:\/.*)?|hooks|layouts|state|utils)$/,
        replacement: uiSource,
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: uiSource,
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
