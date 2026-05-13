import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

// Alias all @elizaos/plugin-* packages that agent/src imports to their source
// so vitest can resolve them without a pre-built dist.
function pluginAlias(name: string, srcPath?: string) {
  const src =
    srcPath ?? path.join(repoRoot, `plugins/${name}/src/index.ts`);
  return { find: `@elizaos/${name}`, replacement: src };
}

export default defineConfig({
  root: here,
  resolve: {
    alias: [
      {
        find: /^@elizaos\/app-core$/,
        replacement: path.join(repoRoot, "packages/app-core/src/index.ts"),
      },
      {
        find: /^@elizaos\/app-core\/(.+)$/,
        replacement: path.join(repoRoot, "packages/app-core/src/$1.ts"),
      },
      {
        find: "@elizaos/core",
        replacement: path.join(repoRoot, "packages/core/src/index.ts"),
      },
      {
        find: "@elizaos/shared",
        replacement: path.join(repoRoot, "packages/shared/src/index.ts"),
      },
      // All plugins imported by packages/agent/src (directly or transitively)
      // that have no pre-built dist — point vitest at source so it can resolve.
      pluginAlias("plugin-signal"),
      pluginAlias("plugin-whatsapp"),
      pluginAlias("plugin-computeruse"),
      pluginAlias("plugin-workflow"),
      pluginAlias("plugin-x402"),
      pluginAlias("plugin-discord", path.join(repoRoot, "plugins/plugin-discord/index.ts")),
      pluginAlias("plugin-aosp-local-inference"),
      pluginAlias("plugin-browser"),
      pluginAlias("plugin-capacitor-bridge"),
      pluginAlias("plugin-coding-tools"),
      pluginAlias("plugin-elizacloud"),
      pluginAlias("plugin-imessage"),
      pluginAlias("plugin-local-inference"),
      pluginAlias("plugin-mcp"),
      pluginAlias("plugin-sql"),
      pluginAlias("plugin-streaming"),
      pluginAlias("plugin-agent-orchestrator"),
      pluginAlias("plugin-shell", path.join(repoRoot, "plugins/plugin-shell/index.ts")),
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
