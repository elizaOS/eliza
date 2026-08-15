/** Configures the unit shared Vitest lane used by workspace package tests. */
import { existsSync } from "node:fs";
import path from "node:path";
import { getElizaCoreEntry } from "../../core/src/testing/eliza-package-paths";
import baseConfig from "./default.config";
import { repoRoot } from "./repo-root";
import {
  getElizaWorkspaceRoot,
  getOptionalResolvedAliases,
  getWorkspacePluginAliases,
  type ModuleAlias,
} from "./workspace-aliases";

const elizaWorkspaceRoot = getElizaWorkspaceRoot(repoRoot);
const elizaCoreEntry = getElizaCoreEntry(repoRoot);

/** This monorepo: core lives in `packages/core` (see `./testing` barrel in package exports). */
const monorepoCoreRoot = path.join(repoRoot, "packages", "core");
const monorepoCoreSource = path.join(monorepoCoreRoot, "src", "index.node.ts");
const localElizaCoreReplacement = existsSync(monorepoCoreSource)
  ? monorepoCoreSource
  : elizaCoreEntry;
const unitAliasEntries: ModuleAlias[] = [
  ...getOptionalResolvedAliases([
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
  ...getOptionalResolvedAliases(
    localElizaCoreReplacement
      ? [
          {
            // Keep the separately bundled public client entry ahead of the
            // prefix-matching bare-core alias below.
            find: /^@elizaos\/core\/client-public$/,
            replacement: path.join(
              path.dirname(localElizaCoreReplacement),
              localElizaCoreReplacement.endsWith(".ts")
                ? "client-public.ts"
                : "client-public.js",
            ),
          },
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
    ],
  },
};
