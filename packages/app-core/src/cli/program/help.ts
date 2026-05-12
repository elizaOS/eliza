import { formatDocsLink, isRich, theme } from "@elizaos/shared";
import type { Command } from "commander";
import { formatCliBannerLine, hasEmittedCliBanner } from "../banner";
import { replaceCliName, resolveCliName } from "../cli-name";

const CLI_NAME = resolveCliName();

const EXAMPLES = [
  ["eliza", "Start Eliza in the interactive TUI."],
  ["eliza start", "Start the classic runtime/chat loop."],
  ["eliza dashboard", "Open the Control UI in your browser."],
  ["eliza setup", "Initialize ~/.eliza/eliza.json and the agent workspace."],
  ["eliza config get agents.defaults.model.primary", "Read a config value."],
  ["eliza models", "Show configured model providers."],
  ["eliza plugins list", "List available plugins."],
  ["eliza update", "Check for and install the latest version."],
  ["eliza update channel beta", "Switch to the beta release channel."],
] as const;

export function configureProgramHelp(program: Command, programVersion: string) {
  program
    .name(CLI_NAME)
    .description("")
    .version(programVersion, "-v, --version")
    .option("--verbose", "Enable informational runtime logs")
    .option("--debug", "Enable debug-level runtime logs")
    .option(
      "--dev",
      "Dev profile: isolate state under ~/.eliza-dev with separate config and ports",
    )
    .option(
      "--profile <name>",
      "Use a named profile (isolates state and config under ~/.eliza-<name>)",
    );

  program.option("--no-color", "Disable ANSI colors", false);

  program.configureHelp({
    optionTerm: (option) => theme.option(option.flags),
    subcommandTerm: (cmd) => theme.command(cmd.name()),
  });

  program.configureOutput({
    writeOut: (str) => {
      const colored = str
        .replace(/^Usage:/gm, theme.heading("Usage:"))
        .replace(/^Options:/gm, theme.heading("Options:"))
        .replace(/^Commands:/gm, theme.heading("Commands:"));
      process.stdout.write(colored);
    },
    writeErr: (str) => process.stderr.write(str),
    outputError: (str, write) => write(theme.error(str)),
  });

  program.addHelpText("beforeAll", () => {
    if (hasEmittedCliBanner()) {
      return "";
    }
    const rich = isRich();
    const line = formatCliBannerLine(programVersion, { richTty: rich });
    return `\n${line}\n`;
  });

  const fmtExamples = EXAMPLES.map(
    ([cmd, desc]) =>
      `  ${theme.command(replaceCliName(cmd, CLI_NAME))}\n    ${theme.muted(desc)}`,
  ).join("\n");

  program.addHelpText("afterAll", ({ command }) => {
    if (command !== program) {
      return "";
    }
    const docs = formatDocsLink("/cli", "docs.eliza.ai/cli");
    return `\n${theme.heading("Examples:")}\n${fmtExamples}\n\n${theme.muted("Docs:")} ${docs}\n`;
  });
}
