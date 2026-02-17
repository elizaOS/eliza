import type { Command } from "commander";
import { theme } from "../../terminal/theme.js";
import { formatDocsLink } from "../../terminal/links.js";
import { runCommandWithRuntime } from "../cli-utils.js";

const defaultRuntime = { error: console.error, exit: process.exit };

async function startAction() {
  await runCommandWithRuntime(defaultRuntime, async () => {
    const { startEliza } = await import("../../eliza.js");
    await startEliza();
  });
}

export function registerStartCommand(program: Command) {
  program
    .command("start", { isDefault: true })
    .description("Start the elizaOS agent runtime")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/getting-started", "docs.milaidy.ai/getting-started")}\n`,
    )
    .action(startAction);

  program
    .command("run")
    .description("Alias for start")
    .action(startAction);
}
