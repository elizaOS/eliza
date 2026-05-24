import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const workspacePluginDirs = [
  path.join(repoRoot, "plugins"),
  path.join(repoRoot, "packages"),
];
const workspaceSourceAliases = [
  {
    find: /^@elizaos\/agent$/,
    replacement: path.join(repoRoot, "packages", "agent", "src", "index.ts"),
  },
  {
    find: /^@elizaos\/agent\/(.*)$/,
    replacement: path.join(repoRoot, "packages", "agent", "src", "$1.ts"),
  },
  {
    find: /^@elizaos\/shared$/,
    replacement: path.join(repoRoot, "packages", "shared", "src", "index.ts"),
  },
];

// Resolve `@elizaos/plugin-*` to workspace source. The scenario runtime
// transitively loads `@elizaos/agent`'s server, whose `server.ts` carries
// dynamic `import("@elizaos/plugin-…")` specifiers for optional plugins
// (x402, browser, …). `test:server` only runs `build:core`, so those plugins
// have no built `dist/` in CI and Vite's eager dynamic-import resolution fails.
// Aliasing to source makes resolution independent of build order.
// Exact-match only (anchored regex): alias the bare package specifier to its
// source entry without rewriting subpath imports like `@elizaos/plugin-x/foo`,
// which must keep their normal resolution.
const pluginSourceAliases = workspacePluginDirs.flatMap((workspaceDir) =>
  existsSync(workspaceDir)
    ? readdirSync(workspaceDir)
        .filter((name) => name.startsWith("plugin-"))
        .map((name) => ({
          name,
          replacement: [
            path.join(workspaceDir, name, "src", "index.ts"),
            path.join(workspaceDir, name, "index.ts"),
          ].find((candidate) => existsSync(candidate)),
        }))
        .filter(
          (entry): entry is { name: string; replacement: string } =>
            entry.replacement !== undefined,
        )
        .map(({ name, replacement }) => ({
          find: new RegExp(`^@elizaos/${name}$`),
          replacement,
        }))
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
    alias: [...workspaceSourceAliases, ...pluginSourceAliases],
  },
});
