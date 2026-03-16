import type { Command } from "commander";
import { theme } from "../../terminal/theme.js";
import { formatDocsLink } from "../../terminal/links.js";

export function registerConfigureCommand(program: Command) {
  program
    .command("configure")
    .description("Configuration guidance")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/configuration", "docs.milaidy.ai/configuration")}\n`,
    )
    .action(() => {
      console.log(`\n${theme.heading("Milaidy Configuration")}\n`);
      console.log("Set values with:");
      console.log(`  ${theme.command("milaidy config get <key>")}     Read a config value`);
      console.log(`  Edit ~/.milaidy/milaidy.json directly for full control.\n`);
      console.log("Common environment variables:");
      console.log(`  ${theme.command("ANTHROPIC_API_KEY")}    Anthropic (Claude)`);
      console.log(`  ${theme.command("OPENAI_API_KEY")}       OpenAI (GPT)`);
      console.log(`  ${theme.command("GOOGLE_API_KEY")}       Google (Gemini)\n`);
    });
}
