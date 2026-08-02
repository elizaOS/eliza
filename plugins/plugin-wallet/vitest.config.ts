/**
 * Package-level vitest config: aliases local workspace dependencies to source
 * so tests resolve without pre-built dist artifacts, and excludes live/opt-in
 * suites (funded-wallet transfer tests, guarded post-merge-only suites) from
 * the default run.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const uiSource = path.resolve(rootDir, "../../packages/ui/src/index.ts");

export default defineConfig({
  // The package tsconfig omits `jsx` (the server tree has none); force the
  // automatic runtime so the merged UI-suite `.tsx` files transform correctly.
  esbuild: { jsx: "automatic" },
  resolve: {
    // Anchored-regex entries (merged from the former plugin-wallet-ui config):
    // force a single React/ReactDOM copy across workspace packages, and
    // collapse `@elizaos/ui` plus the mocked subpaths onto the ui package's
    // SOURCE entry so the suite runs before workspace build artifacts exist.
    // The wallet gui test fully `vi.mock`s `@elizaos/ui`, so the source file is
    // only resolved (to key the mock), never loaded. Anchors keep unlisted
    // subpaths (e.g. `@elizaos/ui/spatial`) resolving through package exports.
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
      { find: /^@elizaos\/ui$/, replacement: uiSource },
      // plugin-health publishes no matching subpath export; redirect to source.
      {
        find: /^@elizaos\/plugin-health\/screen-time\/mobile-signal-setup$/,
        replacement: path.resolve(
          rootDir,
          "../plugin-health/src/screen-time/mobile-signal-setup.ts",
        ),
      },
      {
        find: /^@elizaos\/core$/,
        replacement: path.resolve(
          rootDir,
          "../../packages/core/src/index.node.ts",
        ),
      },
      {
        find: /^@elizaos\/logger$/,
        replacement: path.resolve(
          rootDir,
          "../../packages/logger/src/index.ts",
        ),
      },
      {
        find: /^@elizaos\/shared\/automation-node-contributors$/,
        replacement: path.resolve(
          rootDir,
          "../../packages/shared/src/automation-node-contributors.ts",
        ),
      },
      {
        find: /^@elizaos\/shared$/,
        replacement: path.resolve(
          rootDir,
          "../../packages/shared/src/index.ts",
        ),
      },
    ],
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/**/tasks/**",
      // #9310 §E: the guarded live suites (rpc-providers opt-in gate,
      // birdeye keyless self-skip) are invocable only in the post-merge
      // lane, where run-all-tests.mjs prints a named skip accounting. The
      // unguarded transfer.live file (needs a funded wallet) stays excluded
      // in every lane.
      ...(process.env.VITEST_LANE === "post-merge"
        ? ["src/chains/evm/__tests__/integration/transfer.live.test.ts"]
        : ["src/**/*.live.test.ts"]),
      "src/chains/evm/tests/**",
    ],
  },
});
