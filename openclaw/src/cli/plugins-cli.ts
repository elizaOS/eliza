/**
 * Plugins CLI
 *
 * CLI commands for managing OpenClaw/ElizaOS plugins.
 *
 * Plugin management has been migrated to ElizaOS. This CLI provides
 * guidance on the new plugin management workflow.
 *
 * @module cli/plugins-cli
 */

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
  { name: "@elizaos/plugin-queue", description: "Task queue management" },
  { name: "@elizaos/plugin-agent-skills", description: "Agent skills framework" },
  { name: "@elizaos/plugin-acp", description: "Agent Communication Protocol" },
] as const;

/**
 * Register the plugins CLI commands.
 *
 * @param program - Commander program instance
 */
export function registerPluginsCli(program: Command): void {
  const pluginsCommand = program
    .command("plugins")
    .description("Plugin management (ElizaOS plugins)");

  pluginsCommand
    .command("list")
    .description("List available ElizaOS plugins")
    .action(async () => {
      console.log("\nAvailable ElizaOS plugins:\n");
      for (const plugin of PLUGIN_REGISTRY) {
        console.log(`  ${plugin.name}`);
        console.log(`    ${plugin.description}\n`);
      }
      console.log("To install a plugin, add it to your package.json dependencies:");
      console.log('  "dependencies": {');
      console.log('    "@elizaos/plugin-<name>": "workspace:*"');
      console.log("  }");
      console.log("\nThen run: pnpm install\n");
    });

  pluginsCommand
    .command("info <pluginName>")
    .description("Show information about a plugin")
    .action(async (pluginName: string) => {
      const normalizedName = pluginName.startsWith("@elizaos/plugin-")
        ? pluginName
        : `@elizaos/plugin-${pluginName}`;

      const plugin = PLUGIN_REGISTRY.find((p) => p.name === normalizedName);

      if (plugin) {
        console.log(`\n${plugin.name}`);
        console.log(`  ${plugin.description}`);
        console.log(`\nInstallation:`);
        console.log(`  pnpm add ${plugin.name}`);
        console.log(`\nUsage in character.json:`);
        console.log(`  {`);
        console.log(`    "plugins": ["${plugin.name}"]`);
        console.log(`  }\n`);
      } else {
        console.log(`\nPlugin not found in registry: ${normalizedName}`);
        console.log("\nUse 'openclaw plugins list' to see available plugins.\n");
      }
    });

  pluginsCommand
    .command("install <pluginName>")
    .description("Install an ElizaOS plugin")
    .action(async (pluginName: string) => {
      const normalizedName = pluginName.startsWith("@elizaos/plugin-")
        ? pluginName
        : `@elizaos/plugin-${pluginName}`;

      console.log(`\nTo install ${normalizedName}:\n`);
      console.log(`  pnpm add ${normalizedName}`);
      console.log(`\nThen add it to your character configuration:\n`);
      console.log(`  {`);
      console.log(`    "plugins": ["${normalizedName}"]`);
      console.log(`  }\n`);
    });

  pluginsCommand
    .command("update")
    .description("Update installed plugins")
    .action(async () => {
      console.log("\nTo update all ElizaOS plugins:\n");
      console.log("  pnpm update '@elizaos/*'\n");
      console.log("Or update a specific plugin:\n");
      console.log("  pnpm update @elizaos/plugin-<name>\n");
    });
}
