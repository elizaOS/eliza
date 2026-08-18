/**
 * Vitest configuration for finances unit and React view tests with local module
 * aliases.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/scripts/vitest/default.config";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const elizaRoot = path.resolve(here, "../..");
const uiSrc = path.join(elizaRoot, "packages", "ui", "src");
const vaultSrc = path.join(elizaRoot, "packages", "vault", "src");
const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];

export default defineConfig({
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    // Pin one React copy so jsdom view tests do not mix workspace and hoisted peers.
    alias: [
      {
        find: /^@elizaos\/plugin-elizacloud\/cloud\/managed-payment-clients$/,
        replacement: path.join(
          here,
          "../plugin-elizacloud/src/cloud/managed-payment-clients.ts",
        ),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: path.join(uiSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: path.join(uiSrc, "$1"),
      },
      {
        find: /^@elizaos\/vault$/,
        replacement: path.join(vaultSrc, "index.ts"),
      },
      ...baseAliases,
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
    ],
  },
  test: {
    ...baseConfig.test,
    // Date-only CSV normalization must stay distinguishable from local-time
    // parsing on CI. UTC runners make the unfixed behavior look correct, so
    // pin a non-UTC zone for the package test process.
    env: { ...baseConfig.test?.env, TZ: "America/New_York" },
    // .test.ts run in the default node environment. View component tests live in
    // .test.tsx files and opt into jsdom via a `// @vitest-environment jsdom`
    // docblock at the top of each file.
    environment: "node",
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "test/**/*.{test,spec}.{ts,tsx}",
    ],
  },
});
