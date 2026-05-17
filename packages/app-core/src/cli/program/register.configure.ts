import { formatDocsLink, theme } from "@elizaos/shared";
import type { Command } from "commander";

export function registerConfigureCommand(program: Command) {
  program
    .command("configure")
    .description("Configuration guidance")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/configuration", "docs.eliza.ai/configuration")}\n`,
    )
    .action(() => {
      console.log(`\n${theme.heading("Configuration")}\n`);
      console.log("Set values with:");
      console.log(
        `  ${theme.command("eliza config get <key>")}     Read a config value`,
      );
      console.log(`  Edit ~/.eliza/eliza.json directly for full control.\n`);
      console.log("Common environment variables:");
      console.log(
        `  ${theme.command("ANTHROPIC_API_KEY")}    Anthropic (Claude)`,
      );
      console.log(`  ${theme.command("OPENAI_API_KEY")}       OpenAI (GPT)`);
      console.log(
        `  ${theme.command("AI_GATEWAY_API_KEY")}   Vercel AI Gateway`,
      );
      console.log(
        `  ${theme.command("GOOGLE_API_KEY")}       Google (Gemini)\n`,
      );
    });
}
