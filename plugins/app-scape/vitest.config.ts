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
        find: "@elizaos/core",
        replacement: path.join(repoRoot, "packages/core/src/index.ts"),
      },
      {
        find: "@elizaos/agent",
        replacement: path.join(repoRoot, "packages/agent/src/index.ts"),
      },
      {
        find: "@elizaos/shared",
        replacement: path.join(repoRoot, "packages/shared/src/index.ts"),
      },
      // All plugins in plugins/ that have no pre-built dist — point vitest at
      // source so it can resolve without built artifacts.
      pluginAlias("plugin-agent-orchestrator"),
      pluginAlias("plugin-agent-skills"),
      pluginAlias("plugin-anthropic", path.join(repoRoot, "plugins/plugin-anthropic/index.ts")),
      pluginAlias("plugin-aosp-local-inference"),
      pluginAlias("plugin-app-control"),
      pluginAlias("plugin-background-runner"),
      pluginAlias("plugin-bluebubbles"),
      pluginAlias("plugin-bluesky", path.join(repoRoot, "plugins/plugin-bluesky/index.ts")),
      pluginAlias("plugin-browser"),
      pluginAlias("plugin-calendly"),
      pluginAlias("plugin-capacitor-bridge"),
      pluginAlias("plugin-cli"),
      pluginAlias("plugin-codex-cli", path.join(repoRoot, "plugins/plugin-codex-cli/index.ts")),
      pluginAlias("plugin-coding-tools"),
      pluginAlias("plugin-commands"),
      pluginAlias("plugin-computeruse"),
      pluginAlias("plugin-device-filesystem"),
      pluginAlias("plugin-discord", path.join(repoRoot, "plugins/plugin-discord/index.ts")),
      pluginAlias("plugin-discord-local"),
      pluginAlias("plugin-edge-tts"),
      pluginAlias("plugin-elevenlabs"),
      pluginAlias("plugin-eliza-classic", path.join(repoRoot, "plugins/plugin-eliza-classic/index.ts")),
      pluginAlias("plugin-elizacloud"),
      pluginAlias("plugin-farcaster", path.join(repoRoot, "plugins/plugin-farcaster/index.ts")),
      pluginAlias("plugin-feishu"),
      pluginAlias("plugin-form"),
      pluginAlias("plugin-github"),
      pluginAlias("plugin-google"),
      pluginAlias("plugin-google-chat"),
      pluginAlias("plugin-google-genai", path.join(repoRoot, "plugins/plugin-google-genai/index.ts")),
      pluginAlias("plugin-groq", path.join(repoRoot, "plugins/plugin-groq/index.ts")),
      pluginAlias("plugin-health"),
      pluginAlias("plugin-imessage"),
      pluginAlias("plugin-inmemorydb", path.join(repoRoot, "plugins/plugin-inmemorydb/index.ts")),
      pluginAlias("plugin-instagram"),
      pluginAlias("plugin-line"),
      pluginAlias("plugin-linear"),
      pluginAlias("plugin-lmstudio", path.join(repoRoot, "plugins/plugin-lmstudio/index.ts")),
      pluginAlias("plugin-local-ai", path.join(repoRoot, "plugins/plugin-local-ai/index.ts")),
      pluginAlias("plugin-local-embedding"),
      pluginAlias("plugin-local-inference"),
      pluginAlias("plugin-local-storage"),
      pluginAlias("plugin-localdb", path.join(repoRoot, "plugins/plugin-localdb/index.ts")),
      pluginAlias("plugin-matrix"),
      pluginAlias("plugin-mcp"),
      pluginAlias("plugin-minecraft"),
      pluginAlias("plugin-mlx", path.join(repoRoot, "plugins/plugin-mlx/index.ts")),
      pluginAlias("plugin-music"),
      pluginAlias("plugin-mysticism"),
      pluginAlias("plugin-ngrok"),
      pluginAlias("plugin-nostr"),
      pluginAlias("plugin-ollama", path.join(repoRoot, "plugins/plugin-ollama/index.ts")),
      pluginAlias("plugin-omnivoice"),
      pluginAlias("plugin-openai", path.join(repoRoot, "plugins/plugin-openai/index.ts")),
      pluginAlias("plugin-openrouter", path.join(repoRoot, "plugins/plugin-openrouter/index.ts")),
      pluginAlias("plugin-pdf", path.join(repoRoot, "plugins/plugin-pdf/index.ts")),
      pluginAlias("plugin-rlm", path.join(repoRoot, "plugins/plugin-rlm/index.ts")),
      pluginAlias("plugin-roblox", path.join(repoRoot, "plugins/plugin-roblox/index.ts")),
      pluginAlias("plugin-shell", path.join(repoRoot, "plugins/plugin-shell/index.ts")),
      pluginAlias("plugin-shopify"),
      pluginAlias("plugin-signal"),
      pluginAlias("plugin-slack"),
      pluginAlias("plugin-social-alpha"),
      pluginAlias("plugin-sql"),
      pluginAlias("plugin-streaming"),
      pluginAlias("plugin-suno"),
      pluginAlias("plugin-tailscale"),
      pluginAlias("plugin-tee"),
      pluginAlias("plugin-telegram"),
      pluginAlias("plugin-todos"),
      pluginAlias("plugin-tunnel"),
      pluginAlias("plugin-twitch"),
      pluginAlias("plugin-video"),
      pluginAlias("plugin-vision"),
      pluginAlias("plugin-wallet"),
      pluginAlias("plugin-web-search"),
      pluginAlias("plugin-wechat"),
      pluginAlias("plugin-whatsapp"),
      pluginAlias("plugin-workflow"),
      pluginAlias("plugin-x"),
      pluginAlias("plugin-x402"),
      pluginAlias("plugin-xai", path.join(repoRoot, "plugins/plugin-xai/index.ts")),
      pluginAlias("plugin-zai", path.join(repoRoot, "plugins/plugin-zai/index.ts")),
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
