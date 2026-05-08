import { existsSync } from "node:fs";
import path from "node:path";
import { getElizaCoreEntry } from "../eliza-package-paths";
import baseConfig from "./default.config";
import { repoRoot } from "./repo-root";
import {
  getElizaCoreRolesEntry,
  getElizaWorkspaceRoot,
  getOptionalResolvedAliases,
  getWorkspacePluginAliases,
  type ModuleAlias,
} from "./workspace-aliases";

const elizaWorkspaceRoot = getElizaWorkspaceRoot(repoRoot);
const elizaCoreEntry = getElizaCoreEntry(repoRoot);

// Alias @elizaos/core to workspace source only when its dependencies are installed.
const elizaCoreSource = path.join(
  elizaWorkspaceRoot,
  "packages",
  "typescript",
  "src",
  "index.ts",
);
const useLocalElizaCore =
  existsSync(elizaCoreSource) &&
  existsSync(
    path.join(elizaWorkspaceRoot, "packages", "typescript", "node_modules"),
  );

// Keep the roles shim here too; the base config owns a separate alias array.
const elizaCoreRolesEntry = getElizaCoreRolesEntry(repoRoot);
const localElizaCoreReplacement = useLocalElizaCore
  ? elizaCoreSource
  : elizaCoreEntry;
const unitAliasEntries: ModuleAlias[] = [
  ...getOptionalResolvedAliases([
    {
      find: "@elizaos/plugin-telegram/account-auth-service",
      replacement: path.join(
        elizaWorkspaceRoot,
        "plugins",
        "plugin-telegram",
        "src",
        "account-auth-service.ts",
      ),
    },
    {
      find: "@elizaos/plugin-anthropic",
      replacement: path.join(
        elizaWorkspaceRoot,
        "plugins",
        "plugin-anthropic",
        "typescript",
        "index.ts",
      ),
    },
    {
      find: "@elizaos/plugin-cli",
      replacement: path.join(
        elizaWorkspaceRoot,
        "plugins",
        "plugin-cli",
        "typescript",
        "src",
        "index.ts",
      ),
    },
  ]),
  ...getOptionalResolvedAliases([
    {
      // Always applied — the shim fallback is always present even when the local eliza checkout is disabled.
      find: "@elizaos/core/roles",
      replacement: elizaCoreRolesEntry,
    },
  ]),
  ...getOptionalResolvedAliases(
    useLocalElizaCore
      ? [
          {
            find: "@elizaos/core/testing",
            replacement: path.join(
              elizaWorkspaceRoot,
              "packages",
              "typescript",
              "src",
              "testing",
              "index.ts",
            ),
          },
        ]
      : [],
  ),
  ...getOptionalResolvedAliases(
    localElizaCoreReplacement
      ? [
          {
            // Published-only CI disables the repo-local eliza checkout, so unit tests must fall back to the installed package entry in that mode.
            find: "@elizaos/core",
            replacement: localElizaCoreReplacement,
          },
        ]
      : [],
  ),
  ...getWorkspacePluginAliases(repoRoot, ["plugin-browser"]),
];

export default {
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    alias: unitAliasEntries,
  },
  test: {
    ...baseConfig.test,
    // Keep unit coverage on colocated source tests and shared helpers.
    coverage: {
      ...baseConfig.test?.coverage,
      excludeAfterRemap: true,
      include: [
        "packages/**/src/**/*.ts",
        "apps/**/src/**/*.ts",
        "scripts/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.live.test.ts",
        "**/*.integration.test.ts",
        "**/*.integration.test.tsx",
        "**/*.e2e.test.ts",
        "**/*.e2e.test.tsx",
        "dist/**",
        "**/node_modules/**",
        "eliza/packages/app-core/src/**/*.tsx",
        "eliza/packages/app-core/src/i18n/**",
        "eliza/packages/app-core/src/platform/**",
        "eliza/packages/app-core/test/app/**",
      ],
    },
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "**/*.live.test.ts",
      "**/*.integration.test.ts",
      "**/*.integration.test.tsx",
      "**/*.e2e.test.ts",
      "**/*.e2e.test.tsx",
      "eliza/packages/app-core/test/app/**",
    ],
  },
};
