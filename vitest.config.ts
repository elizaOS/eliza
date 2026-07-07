/**
 * Root Vitest configuration for workspace tests that run directly against source.
 *
 * The aliases point package imports at their TypeScript entry points so targeted
 * package tests can execute without first building every workspace.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.git/**",
      "**/.claude/**",
      "**/.eliza/**",
      "**/.tmp/**",
      "**/tmp/**",
      "**/*.e2e.test.{ts,tsx}",
      "**/*.e2e.spec.{ts,tsx}",
      "**/*.live.test.{ts,tsx}",
      "**/*.live.e2e.test.{ts,tsx}",
      "**/*.real.test.{ts,tsx}",
      "**/*.real.e2e.test.{ts,tsx}",
    ],
  },
  resolve: {
    alias: [
      {
        // plugin-app-control's build (tsup, index + worker entries only)
        // never emits dist/actions/*.js; the agent's settings-actions.ts
        // subpath import resolves only under the `eliza-source` exports
        // condition, which vite's resolver ignores. Pin it to source so any
        // test whose graph loads @elizaos/agent (aliased to src below) boots.
        find: /^@elizaos\/plugin-app-control\/actions\/settings$/,
        replacement: path.join(
          root,
          "plugins/plugin-app-control/src/actions/settings.ts",
        ),
      },
      {
        find: /^@elizaos\/app-core$/,
        replacement: path.join(root, "packages/app-core/src/index.ts"),
      },
      {
        find: /^@elizaos\/app-core\/(.+)$/,
        replacement: path.join(root, "packages/app-core/src/$1"),
      },
      {
        find: /^@elizaos\/agent$/,
        replacement: path.join(root, "packages/agent/src/index.ts"),
      },
      {
        find: /^@elizaos\/agent\/(.+)$/,
        replacement: path.join(root, "packages/agent/src/$1"),
      },
      {
        // The agent's settings action imports the shared parser from this
        // subpath (#14804); app-control's build bundles only the barrel, so
        // without the eliza-source condition the subpath has no dist file to
        // resolve to and must be pinned to source here.
        find: /^@elizaos\/plugin-app-control\/(.+)$/,
        replacement: path.join(root, "plugins/plugin-app-control/src/$1"),
      },
      {
        find: /^@elizaos\/logger$/,
        replacement: path.join(root, "packages/logger/src/index.ts"),
      },
      {
        find: /^@elizaos\/core$/,
        replacement: path.join(root, "packages/core/src/index.node.ts"),
      },
      {
        // "./node" is an exports-map subpath (→ index.node.ts), not a real
        // src path, so it must be pinned before the generic src/$1 rewrite.
        find: /^@elizaos\/core\/node$/,
        replacement: path.join(root, "packages/core/src/index.node.ts"),
      },
      {
        find: /^@elizaos\/core\/(.+)$/,
        replacement: path.join(root, "packages/core/src/$1"),
      },
      {
        find: /^@elizaos\/shared$/,
        replacement: path.join(root, "packages/shared/src/index.ts"),
      },
      {
        find: /^@elizaos\/shared\/(.+)$/,
        replacement: path.join(root, "packages/shared/src/$1"),
      },
      {
        // Leaf auth package (account storage, credentials, oauth flows,
        // atomic-json). It ships no dist in the test lane, so its `.` and `./*`
        // exports resolve to `dist/*.js` and vite fails with "Cannot find
        // package '@elizaos/auth/...'". Pin both the barrel and subpaths to
        // source so targeted tests (e.g. remote-plugin-adapter → app-package
        // -modules → `@elizaos/auth/atomic-json`) resolve without a build.
        find: /^@elizaos\/auth$/,
        replacement: path.join(root, "packages/auth/src/index.ts"),
      },
      {
        find: /^@elizaos\/auth\/(.+)$/,
        replacement: path.join(root, "packages/auth/src/$1"),
      },
      {
        find: /^@elizaos\/vault$/,
        replacement: path.join(root, "packages/vault/src/index.ts"),
      },
      {
        find: /^@elizaos\/vault\/(.+)$/,
        replacement: path.join(root, "packages/vault/src/$1"),
      },
      {
        find: /^@elizaos\/cloud-sdk$/,
        replacement: path.join(root, "packages/cloud/sdk/src/index.ts"),
      },
      {
        find: /^@elizaos\/cloud-sdk\/(.+)$/,
        replacement: path.join(root, "packages/cloud/sdk/src/$1"),
      },
      {
        // Core's src re-exports the cloud routing surface from
        // `@elizaos/cloud-routing` (packages/core/src/cloud-routing.ts), which
        // ships no dist. With @elizaos/core source-aliased above, that re-export
        // only resolves when cloud-routing is pinned to source too — otherwise
        // vite falls through to its `dist/index.js` entry and fails with
        // "Failed to resolve entry for @elizaos/cloud-routing".
        find: /^@elizaos\/cloud-routing$/,
        replacement: path.join(root, "packages/cloud/routing/src/index.ts"),
      },
      {
        find: /^@elizaos\/cloud-routing\/(.+)$/,
        replacement: path.join(root, "packages/cloud/routing/src/$1"),
      },
      {
        find: /^@elizaos\/tui$/,
        replacement: path.join(root, "packages/tui/src/index.ts"),
      },
      {
        find: /^@elizaos\/tui\/(.+)$/,
        replacement: path.join(root, "packages/tui/src/$1"),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: path.join(root, "packages/ui/src/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: path.join(root, "packages/ui/src/$1"),
      },
      {
        find: /^@elizaos\/vault$/,
        replacement: path.join(root, "packages/vault/src/index.ts"),
      },
      {
        find: /^@elizaos\/vault\/(.+)$/,
        replacement: path.join(root, "packages/vault/src/$1"),
      },
      {
        find: /^@elizaos\/tui$/,
        replacement: path.join(root, "packages/tui/src/index.ts"),
      },
      {
        find: /^@elizaos\/tui\/(.+)$/,
        replacement: path.join(root, "packages/tui/src/$1"),
      },
    ],
  },
});
