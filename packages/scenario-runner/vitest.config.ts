import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const workspacePluginDirs = [
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
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name?: string;
  };
  if (!packageJson.name?.startsWith("@elizaos/")) {
    return undefined;
  }
  if (packageJson.name === "@elizaos/scenario-runner") {
    return undefined;
  }

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

// Resolve workspace `@elizaos/*` packages to source. The scenario runtime
// transitively loads `@elizaos/agent`'s server, whose `server.ts` carries
// dynamic `import("@elizaos/plugin-...")` specifiers for optional plugins
// (x402, browser, ...). `test:server` only runs `build:core`, so those plugins
// have no built `dist/` in CI and Vite's eager dynamic-import resolution fails.
// Aliasing to source makes resolution independent of build order.
const workspaceSourceAliases = workspacePluginDirs.flatMap((workspaceDir) =>
  existsSync(workspaceDir)
    ? readdirSync(workspaceDir)
        .map((name) => getSourceAliasEntry(path.join(workspaceDir, name)))
        .filter((entry): entry is SourceAliasEntry => entry !== undefined)
        .flatMap(({ packageName, indexPath, sourceDir }) => [
          {
            find: new RegExp(`^${packageName}$`),
            replacement: indexPath,
          },
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
    include: ["src/**/*.test.ts", "src/__tests__/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
    testTimeout: 180_000,
  },
  resolve: {
    alias: [
      {
        find: /^@elizaos\/core\/testing$/,
        replacement: path.join(repoRoot, "packages/core/src/testing/index.ts"),
      },
      {
        find: /^@elizaos\/scenario-runner\/schema$/,
        replacement: path.join(
          repoRoot,
          "packages/scenario-runner/schema/index.js",
        ),
      },
      {
        find: /^@elizaos\/core\/node$/,
        replacement: path.join(repoRoot, "packages/core/src/index.node.ts"),
      },
      {
        find: /^@elizaos\/shared\/brand$/,
        replacement: path.join(repoRoot, "packages/shared/src/brand/index.ts"),
      },
      {
        find: /^@elizaos\/shared\/brand-classic$/,
        replacement: path.join(
          repoRoot,
          "packages/shared/src/brand-classic/index.ts",
        ),
      },
      {
        find: /^@elizaos\/shared\/types$/,
        replacement: path.join(repoRoot, "packages/shared/src/types/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/agent-surface$/,
        replacement: path.join(
          repoRoot,
          "packages/ui/src/agent-surface/index.ts",
        ),
      },
      {
        find: /^@elizaos\/ui\/components\/ui\/(.*)$/,
        replacement: path.join(
          repoRoot,
          "packages/ui/src/components/ui/$1.tsx",
        ),
      },
      ...workspaceSourceAliases,
    ],
  },
});
