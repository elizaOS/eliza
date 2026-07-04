/** Vitest config for @elizaos/plugin-relationships: extends the shared base config with the package's local aliases. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];

// The unit suite covers the RelationshipsView render + kind-filter + refresh +
// retry interaction (src/components/relationships/RelationshipsView.test.tsx,
// jsdom via per-file directive) and the existing scaffold contract guard
// (src/plugin.test.ts, node env). The base config supplies the @elizaos/* source
// aliases that plugin.ts needs; the React aliases below pin a single React copy
// so jsdom does not mix the workspace and hoisted peers (mirrors plugin-inbox).
const liveOnlyExcludes = [
  "dist/**",
  "**/node_modules/**",
  "**/*.live.test.{ts,tsx}",
  "**/*.live.e2e.test.{ts,tsx}",
  "**/*.real.test.{ts,tsx}",
  "**/*.real.e2e.test.{ts,tsx}",
  "**/*.integration.test.{ts,tsx}",
  "**/*.e2e.test.{ts,tsx}",
];

export default defineConfig({
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
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
        find: /^react\/jsx-dev-runtime$/,
        replacement: require.resolve("react/jsx-dev-runtime"),
      },
      {
        find: /^react-dom$/,
        replacement: path.dirname(require.resolve("react-dom/package.json")),
      },
      {
        find: /^react-dom\/client$/,
        replacement: require.resolve("react-dom/client"),
      },
      ...baseAliases,
    ],
  },
  test: {
    ...baseConfig.test,
    root: here,
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "test/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: liveOnlyExcludes,
  },
});
