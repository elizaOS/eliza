/**
 * Resolves workspace sources for real-runtime tests without requiring builds.
 * Core exposes only its public root; removed subpaths remain subject to package
 * exports. Other workspaces retain their declared source entries and barriers.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPackages } from "../lib/workspaces.mjs";

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
  blockedExactSubpaths: string[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Vite strips query/hash suffixes before resolving a module and maps explicit
// JavaScript-family spellings back to TypeScript sources (for example `.js`
// and `.jsx` can resolve to an existing `.ts` file). JSON is also in Vite's
// default extension set. These spellings must not turn an exact `null` package
// export back into a source alias. Descendant subpaths stay eligible because an
// exact `./private: null` export does not itself block `./private/*`.
const VITE_EQUIVALENT_EXTENSION_PATTERN = String.raw`\.(?:mjs|js|mts|ts|jsx|tsx|cjs|cts|json)`;

// A generic source alias is a test-only affordance, so only canonical package
// subpaths may use it. Vite normalizes repeated separators and `.` / `..`
// segments after alias replacement; accepting those spellings here can route a
// noncanonical request onto a different source file before package `exports`
// gets a say. Percent-encoded dots and separators are invalid package subpaths
// and stay under the real resolver too. Query/hash contents are excluded from
// these pathname checks.
const CANONICAL_PACKAGE_SUBPATH_GUARD = [
  "(?=[^/?#])",
  "(?!\\.{1,2}(?:/|[?#]|$))",
  "(?![^?#]*/\\.{1,2}(?:/|[?#]|$))",
  "(?![^?#]*//)",
  "(?![^?#]*\\\\)",
  "(?![^?#]*%(?:2[eEfF]|5[cC]))",
].join("");

function packageSubpathAliasMatcher(
  packageName: string,
  blockedExactSubpaths: string[],
  capturePattern: string,
): RegExp {
  const blockedPattern =
    blockedExactSubpaths.length > 0
      ? `(?!(?:${blockedExactSubpaths.map(escapeRegex).join("|")})(?:${VITE_EQUIVALENT_EXTENSION_PATTERN})?(?:[?#].*)?$)`
      : "";
  return new RegExp(
    `^${escapeRegex(packageName)}/${CANONICAL_PACKAGE_SUBPATH_GUARD}${blockedPattern}(${capturePattern})$`,
  );
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
      | null
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
  if (packageJson.name === "@elizaos/testing") return undefined;
  const packageExports = packageJson.exports ?? {};
  const blockedExactSubpaths = Object.entries(packageExports).flatMap(
    ([subpath, target]) =>
      target === null && subpath.startsWith("./") && !subpath.includes("*")
        ? [subpath.slice(2)]
        : [],
  );
  const exportedSourceAliases = Object.entries(packageExports).flatMap(
    ([subpath, target]) => {
      if (target === null || typeof target === "string") return [];
      const source = target["eliza-source"];
      const sourcePath =
        typeof source === "string"
          ? source
          : (source?.import ?? source?.default ?? source?.types);
      if (
        !sourcePath?.startsWith("./") ||
        (subpath !== "." && !subpath.startsWith("./")) ||
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
          subpath: subpath === "." ? "." : subpath.slice(2),
          sourcePath: resolvedSourcePath,
        },
      ];
    },
  );
  const declaredRoot = exportedSourceAliases.find(
    ({ subpath }) => subpath === ".",
  );
  const subpathAliases = exportedSourceAliases.filter(
    ({ subpath }) => subpath !== ".",
  );
  if (declaredRoot) {
    return {
      packageName: packageJson.name,
      indexPath: declaredRoot.sourcePath,
      sourceDir:
        existsSync(path.join(packageDir, "src", "index.ts")) ||
        !existsSync(path.join(packageDir, "index.ts"))
          ? path.join(packageDir, "src")
          : packageDir,
      exportedSourceAliases: subpathAliases,
      blockedExactSubpaths,
    };
  }
  const sourceIndex = path.join(packageDir, "src", "index.ts");
  if (existsSync(sourceIndex)) {
    return {
      packageName: packageJson.name,
      indexPath: sourceIndex,
      sourceDir: path.join(packageDir, "src"),
      exportedSourceAliases,
      blockedExactSubpaths,
    };
  }
  const rootIndex = path.join(packageDir, "index.ts");
  if (existsSync(rootIndex)) {
    return {
      packageName: packageJson.name,
      indexPath: rootIndex,
      sourceDir: packageDir,
      exportedSourceAliases,
      blockedExactSubpaths,
    };
  }
  return undefined;
}

/** Builds ordered source aliases; explicit package roots precede generic rules. */
export function buildWorkspaceSourceAliases(
  repoRoot: string = workspaceRepoRoot,
): SourceAlias[] {
  const workspaceSourceAliases = listPackages({ repoRoot })
    .map(({ dir }: { dir: string }) =>
      getWorkspaceSourceEntry(path.join(repoRoot, dir)),
    )
    .filter((entry): entry is WorkspaceSourceEntry => entry !== undefined)
    .flatMap(
      ({
        packageName,
        indexPath,
        sourceDir,
        exportedSourceAliases,
        blockedExactSubpaths,
      }) =>
        packageName === "@elizaos/core"
          ? [
              {
                find: /^@elizaos\/core$/,
                replacement: indexPath,
              },
            ]
          : [
              ...exportedSourceAliases.map(({ subpath, sourcePath }) => ({
                find: new RegExp(
                  `^${escapeRegex(packageName)}/${escapeRegex(subpath)}$`,
                ),
                replacement: sourcePath,
              })),
              {
                find: new RegExp(`^${escapeRegex(packageName)}$`),
                replacement: indexPath,
              },
              // Asset subpaths (JSON data imports like
              // `@elizaos/registry/first-party/curated-app-definitions.json`)
              // resolve to the source file as-is; the generic rule below would
              // otherwise append `.ts` and break the resolve. First-match wins.
              {
                find: packageSubpathAliasMatcher(
                  packageName,
                  blockedExactSubpaths,
                  ".*\\.json",
                ),
                replacement: path.join(sourceDir, "$1"),
              },
              {
                // Exact null exports are excluded so the package resolver can
                // enforce their private barrier instead of this source alias
                // bypassing it through a matching file under `src`.
                find: packageSubpathAliasMatcher(
                  packageName,
                  blockedExactSubpaths,
                  ".*",
                ),
                // Keep the target extensionless so Vite can resolve either a
                // source file (`foo.ts`) or a public directory entry
                // (`foo/index.ts`) through the same package-subpath rule.
                replacement: path.join(sourceDir, "$1"),
              },
            ],
    );

  return [
    {
      find: /^@elizaos\/testing$/,
      replacement: path.join(repoRoot, "packages/testing/src/index.ts"),
    },
    {
      find: /^@elizaos\/plugin-sql$/,
      replacement: path.join(repoRoot, "plugins/plugin-sql/src/index.node.ts"),
    },
    ...workspaceSourceAliases,
  ];
}
