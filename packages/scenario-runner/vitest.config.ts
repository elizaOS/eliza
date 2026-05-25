import { existsSync, readFileSync, readdirSync } from "node:fs";
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

  const packageJson = JSON.parse(
    readFileSync(packageJsonPath, "utf8"),
  ) as { name?: string };
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
// dynamic `import("@elizaos/plugin-…")` specifiers for optional plugins
// (x402, browser, …). `test:server` only runs `build:core`, so those plugins
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
    alias: workspaceSourceAliases,
  },
});
