import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve every workspace `@elizaos/*` package to source so booting a real
// AgentRuntime is independent of build order (mirrors scenario-runner's config).
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const workspaceDirs = [
  path.join(repoRoot, "plugins"),
  path.join(repoRoot, "packages"),
];

type SourceAliasEntry = {
  packageName: string;
  indexPath: string;
  sourceDir: string;
};

const getSourceAliasEntry = (
  packageDir: string,
): SourceAliasEntry | undefined => {
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name?: string;
  };
  if (!packageJson.name?.startsWith("@elizaos/")) return undefined;
  // The harness itself resolves via its package.json exports.
  if (packageJson.name === "@elizaos/test-harness") return undefined;
  const sourceIndex = path.join(packageDir, "src", "index.ts");
  const rootIndex = path.join(packageDir, "index.ts");
  if (existsSync(sourceIndex)) {
    return {
      packageName: packageJson.name,
      indexPath: sourceIndex,
      sourceDir: path.join(packageDir, "src"),
    };
  }
  if (existsSync(rootIndex)) {
    return {
      packageName: packageJson.name,
      indexPath: rootIndex,
      sourceDir: packageDir,
    };
  }
  return undefined;
};

const workspaceSourceAliases = workspaceDirs.flatMap((dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .map((name) => getSourceAliasEntry(path.join(dir, name)))
        .filter((entry): entry is SourceAliasEntry => entry !== undefined)
        .flatMap(({ packageName, indexPath, sourceDir }) => [
          { find: new RegExp(`^${packageName}$`), replacement: indexPath },
          {
            find: new RegExp(`^${packageName}/(.*)$`),
            replacement: path.join(sourceDir, "$1.ts"),
          },
        ])
    : [],
);

export default defineConfig({
  test: {
    environment: "node",
    include: ["harness/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: "forks",
  },
  resolve: {
    alias: [
      // Explicit entries win over the generic ones (Vite is first-match).
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
        replacement: path.join(
          repoRoot,
          "plugins/plugin-sql/src/index.node.ts",
        ),
      },
      ...workspaceSourceAliases,
    ],
  },
});
