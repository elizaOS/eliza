/**
 * Shared Vitest source-alias builder for `withMockLlmRuntime()` consumers.
 *
 * Booting a real PGLite-backed AgentRuntime requires every workspace
 * `@elizaos/*` package to resolve to its TypeScript source (independent of
 * build order), plus the three subpath specials the runtime touches:
 * `@elizaos/core/testing`, `@elizaos/core/node`, and `@elizaos/plugin-sql`
 * (the node entry). The harness's own `vitest.config.ts` needs this, and so
 * does every per-plugin harness config that imports `@elizaos/test-harness`.
 * Both consume this one builder so the alias set never drifts.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Vite rollup alias shape (structural to avoid duplicate vite typings). */
export interface SourceAlias {
  find: RegExp;
  replacement: string;
}

/** The elizaOS monorepo root (three levels up from `packages/test/harness`). */
export const harnessRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

interface WorkspaceSourceEntry {
  packageName: string;
  indexPath: string;
  sourceDir: string;
}

function getWorkspaceSourceEntry(
  packageDir: string,
): WorkspaceSourceEntry | undefined {
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name?: string;
  };
  if (!packageJson.name?.startsWith("@elizaos/")) return undefined;
  // The harness itself resolves via its package.json exports.
  if (packageJson.name === "@elizaos/test-harness") return undefined;
  const sourceIndex = path.join(packageDir, "src", "index.ts");
  if (existsSync(sourceIndex)) {
    return {
      packageName: packageJson.name,
      indexPath: sourceIndex,
      sourceDir: path.join(packageDir, "src"),
    };
  }
  const rootIndex = path.join(packageDir, "index.ts");
  if (existsSync(rootIndex)) {
    return {
      packageName: packageJson.name,
      indexPath: rootIndex,
      sourceDir: packageDir,
    };
  }
  return undefined;
}

/**
 * Build the full alias list for a harness consumer. Explicit entries
 * (`@elizaos/core/testing`, `@elizaos/core/node`, `@elizaos/plugin-sql`) are
 * placed first so they win over the generic per-package rules (Vite is
 * first-match).
 */
export function buildHarnessSourceAliases(
  repoRoot: string = harnessRepoRoot,
): SourceAlias[] {
  const workspaceDirs = [
    path.join(repoRoot, "plugins"),
    path.join(repoRoot, "packages"),
  ];

  const workspaceSourceAliases = workspaceDirs.flatMap((dir) =>
    existsSync(dir)
      ? readdirSync(dir)
          .map((name) => getWorkspaceSourceEntry(path.join(dir, name)))
          .filter((entry): entry is WorkspaceSourceEntry => entry !== undefined)
          .flatMap(({ packageName, indexPath, sourceDir }) => [
            { find: new RegExp(`^${packageName}$`), replacement: indexPath },
            // Asset subpaths (JSON data imports like
            // `@elizaos/registry/first-party/curated-app-definitions.json`)
            // resolve to the source file as-is; the generic rule below would
            // otherwise append `.ts` and break the resolve. First-match wins.
            {
              find: new RegExp(`^${packageName}/(.*\\.json)$`),
              replacement: path.join(sourceDir, "$1"),
            },
            {
              find: new RegExp(`^${packageName}/(.*)$`),
              replacement: path.join(sourceDir, "$1.ts"),
            },
          ])
      : [],
  );

  return [
    {
      find: /^@elizaos\/core\/testing$/,
      replacement: path.join(repoRoot, "packages/core/src/testing/index.ts"),
    },
    {
      find: /^@elizaos\/core\/node$/,
      replacement: path.join(repoRoot, "packages/core/src/index.node.ts"),
    },
    {
      find: /^@elizaos\/plugin-sql$/,
      replacement: path.join(repoRoot, "plugins/plugin-sql/src/index.node.ts"),
    },
    ...workspaceSourceAliases,
  ];
}
