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
  return [name, src] as [string, string];
}

export default defineConfig({
  root: here,
  resolve: {
    alias: {
      "@elizaos/core": path.join(repoRoot, "packages/core/src/index.ts"),
      "@elizaos/agent": path.join(repoRoot, "packages/agent/src/index.ts"),
      "@elizaos/shared": path.join(repoRoot, "packages/shared/src/index.ts"),
      ...Object.fromEntries([
        pluginAlias("plugin-signal"),
        pluginAlias("plugin-whatsapp"),
        pluginAlias("plugin-computeruse"),
        pluginAlias("plugin-workflow"),
        pluginAlias("plugin-x402"),
        pluginAlias(
          "plugin-discord",
          path.join(repoRoot, "plugins/plugin-discord/index.ts"),
        ),
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
      ]),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
