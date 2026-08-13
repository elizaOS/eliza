/**
 * Shared Vitest source-alias builder for real-runtime test consumers.
 *
 * Booting a real PGLite-backed AgentRuntime requires every workspace
 * `@elizaos/*` package to resolve to its TypeScript source (independent of
 * build order), plus the core and SQL subpath specials the runtime touches:
 * `@elizaos/core/testing`, `@elizaos/core/node`, `@elizaos/core/connectors`,
 * and `@elizaos/plugin-sql` (the node entry). Package exports that declare an
 * exact `eliza-source` condition contribute their own source aliases, including
 * provider-owned endpoint diagnostics that otherwise require prebuilt dist.
 * Shared and per-plugin real-runtime configs need this, and so does
 * every per-plugin runtime config that imports `@elizaos/core/testing`.
 * Both consume this one builder so the alias set never drifts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Vite rollup alias shape (structural to avoid duplicate vite typings). */
export interface SourceAlias {
  find: RegExp;
  replacement: string;
}

/** The elizaOS monorepo root (three levels up from `packages/scripts/vitest`). */
export const workspaceRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

interface WorkspaceSourceEntry {
  packageName: string;
  indexPath: string;
  sourceDir: string;
  exportedSourceAliases: Array<{ subpath: string; sourcePath: string }>;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getWorkspaceSourceEntry(
  packageDir: string,
): WorkspaceSourceEntry | undefined {
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name?: string;
    exports?: Record<
      string,
      | string
      | {
          "eliza-source"?:
            | string
            | { import?: string; default?: string; types?: string };
        }
    >;
  };
  if (!packageJson.name?.startsWith("@elizaos/")) return undefined;
  // The testing surface resolves through the explicit alias below.
  if (packageJson.name === "@elizaos/core/testing") return undefined;
  const exportedSourceAliases = Object.entries(
    packageJson.exports ?? {},
  ).flatMap(([subpath, target]) => {
    if (subpath === "." || typeof target === "string") return [];
    const source = target["eliza-source"];
    const sourcePath =
      typeof source === "string"
        ? source
        : (source?.import ?? source?.default ?? source?.types);
    if (
      !sourcePath?.startsWith("./") ||
      !subpath.startsWith("./") ||
      subpath.includes("*")
    )
      return [];
    const resolvedSourcePath = path.resolve(packageDir, sourcePath);
    if (
      !resolvedSourcePath.startsWith(`${path.resolve(packageDir)}${path.sep}`)
    )
      return [];
    return [
      {
        subpath: subpath.slice(2),
        sourcePath: resolvedSourcePath,
      },
    ];
  });
  const sourceIndex = path.join(packageDir, "src", "index.ts");
  if (existsSync(sourceIndex)) {
    return {
      packageName: packageJson.name,
      indexPath: sourceIndex,
      sourceDir: path.join(packageDir, "src"),
      exportedSourceAliases,
    };
  }
  const rootIndex = path.join(packageDir, "index.ts");
  if (existsSync(rootIndex)) {
    return {
      packageName: packageJson.name,
      indexPath: rootIndex,
      sourceDir: packageDir,
      exportedSourceAliases,
    };
  }
  return undefined;
}

/**
 * Directory names that never contain workspace packages — pruned from the
 * recursive descent so we don't walk into installed deps or build output.
 */
const PRUNE_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".git",
  "coverage",
]);

/**
 * Collect every workspace package dir under `root`, descending through
 * grouping directories that are not themselves packages.
 *
 * The eliza monorepo nests published `@elizaos/*` packages several levels deep
 * (e.g. `@elizaos/cloud-routing` at `packages/cloud/routing`, gateways at
 * `packages/cloud/services/*`). A flat `readdirSync(packages)` misses those, so
 * their source alias is never emitted and Vite falls back to the
 * package `exports` -> `dist/index.js`, which does not exist under the keyless
 * `--ignore-scripts` install. That surfaces as
 * `Failed to resolve entry for package "@elizaos/cloud-routing"` in every
 * per-plugin runtime proof (core re-exports the cloud routing surface).
 *
 * Descend recursively but stop at the first directory that IS a package (a
 * package's own subdirs are not separate workspace packages), and prune known
 * non-source dirs. `maxDepth` bounds the walk defensively.
 */
function collectWorkspacePackageDirs(root: string, maxDepth = 4): string[] {
  if (!existsSync(root) || maxDepth < 0) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    if (PRUNE_DIRS.has(name)) continue;
    const child = path.join(root, name);
    if (!statSync(child).isDirectory()) continue;
    if (existsSync(path.join(child, "package.json"))) {
      // A package dir: record it and do not descend (its subdirs belong to it).
      out.push(child);
    } else {
      // A grouping dir: keep descending to find nested packages.
      out.push(...collectWorkspacePackageDirs(child, maxDepth - 1));
    }
  }
  return out;
}

/**
 * Build the full alias list for a real-runtime consumer. Explicit entries
 * (`@elizaos/core/testing`, `@elizaos/core/node`, `@elizaos/core/connectors`,
 * `@elizaos/plugin-sql`) are
 * placed first so they win over the generic per-package rules (Vite is
 * first-match).
 */
export function buildWorkspaceSourceAliases(
  repoRoot: string = workspaceRepoRoot,
): SourceAlias[] {
  const workspaceDirs = [
    path.join(repoRoot, "plugins"),
    path.join(repoRoot, "packages"),
  ];

  const workspaceSourceAliases = workspaceDirs.flatMap((dir) =>
    existsSync(dir)
      ? collectWorkspacePackageDirs(dir)
          .map((packageDir) => getWorkspaceSourceEntry(packageDir))
          .filter((entry): entry is WorkspaceSourceEntry => entry !== undefined)
          .flatMap(
            ({ packageName, indexPath, sourceDir, exportedSourceAliases }) => [
              ...exportedSourceAliases.map(({ subpath, sourcePath }) => ({
                find: new RegExp(
                  `^${escapeRegex(packageName)}/${escapeRegex(subpath)}$`,
                ),
                replacement: sourcePath,
              })),
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
                // Keep the target extensionless so Vite can resolve either a
                // source file (`foo.ts`) or a public directory entry
                // (`foo/index.ts`) through the same package-subpath rule.
                replacement: path.join(sourceDir, "$1"),
              },
            ],
          )
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
      find: /^@elizaos\/core\/roles$/,
      replacement: path.join(repoRoot, "packages/core/src/roles.ts"),
    },
    {
      find: /^@elizaos\/core\/connectors$/,
      replacement: path.join(repoRoot, "packages/core/src/connectors.ts"),
    },
    {
      find: /^@elizaos\/core\/atomic-json$/,
      replacement: path.join(
        repoRoot,
        "packages/core/src/utils/atomic-json.ts",
      ),
    },
    {
      find: /^@elizaos\/plugin-sql$/,
      replacement: path.join(repoRoot, "plugins/plugin-sql/src/index.node.ts"),
    },
    ...workspaceSourceAliases,
  ];
}
