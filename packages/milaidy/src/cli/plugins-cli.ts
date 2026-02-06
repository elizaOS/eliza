import type { Command } from "commander";

const PLUGIN_REGISTRY = [
  { name: "@elizaos/plugin-anthropic", description: "Anthropic Claude models" },
  { name: "@elizaos/plugin-openai", description: "OpenAI GPT models" },
  { name: "@elizaos/plugin-google-genai", description: "Google Gemini models" },
  { name: "@elizaos/plugin-groq", description: "Groq inference" },
  { name: "@elizaos/plugin-ollama", description: "Local Ollama models" },
  { name: "@elizaos/plugin-xai", description: "xAI Grok models" },
  { name: "@elizaos/plugin-openrouter", description: "OpenRouter multi-model gateway" },
  { name: "@elizaos/plugin-telegram", description: "Telegram bot integration" },
  { name: "@elizaos/plugin-discord", description: "Discord bot integration" },
  { name: "@elizaos/plugin-whatsapp", description: "WhatsApp integration" },
  { name: "@elizaos/plugin-shell", description: "Shell command execution" },
  { name: "@elizaos/plugin-browser", description: "Browser automation" },
  { name: "@elizaos/plugin-sql", description: "SQL database integration" },
  { name: "@elizaos/plugin-cron", description: "Scheduled tasks" },
  { name: "@elizaos/plugin-cli", description: "CLI interface" },
  { name: "@elizaos/plugin-code", description: "Code analysis and execution" },
  { name: "@elizaos/plugin-directives", description: "Response directives" },
  { name: "@elizaos/plugin-agent-skills", description: "Agent skills framework" },
  { name: "@elizaos/plugin-acp", description: "Agent Communication Protocol" },
] as const;

export function registerPluginsCli(program: Command): void {
  const pluginsCommand = program
    .command("plugins")
    .description("List available ElizaOS plugins");

  pluginsCommand
    .command("list")
    .description("List available ElizaOS plugins")
    .action(() => {
      console.log("\nAvailable ElizaOS plugins:\n");
      for (const plugin of PLUGIN_REGISTRY) {
        console.log(`  ${plugin.name}`);
        console.log(`    ${plugin.description}\n`);
      }
      console.log("Install:  pnpm add <package-name>");
      console.log("Example:  pnpm add @elizaos/plugin-anthropic");
      console.log("Then add the package name to your character.json plugins array.\n");
    });

  pluginsCommand
    .command("info <pluginName>")
    .description("Show information about a plugin")
    .action((pluginName: string) => {
      const normalizedName = pluginName.startsWith("@elizaos/plugin-")
        ? pluginName
        : `@elizaos/plugin-${pluginName}`;

      const plugin = PLUGIN_REGISTRY.find((p) => p.name === normalizedName);

      if (plugin) {
        console.log(`\n${plugin.name}`);
        console.log(`  ${plugin.description}`);
        console.log(`\nInstall:  pnpm add ${plugin.name}`);
        console.log(`Then add to character.json:  "plugins": ["${plugin.name}"]\n`);
      } else {
        console.log(`\nPlugin not found: ${normalizedName}`);
        console.log("Run 'milaidy plugins list' to see available plugins.\n");
      }
    });
}
