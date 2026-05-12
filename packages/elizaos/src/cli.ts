#!/usr/bin/env node

import * as clack from "@clack/prompts";
import { Command } from "commander";
import {
  create,
  info,
  registerPluginsCommand,
  submitPluginToRegistry,
  upgrade,
  version,
} from "./commands/index.js";
import { getCliVersion } from "./package-info.js";

const program = new Command();

async function defaultAction(): Promise<void> {
  const choice = await clack.select({
    message: "What do you want to do?",
    options: [
      { value: "create", label: "Create a new project" },
      { value: "upgrade", label: "Upgrade the current project" },
      { value: "info", label: "Show available templates" },
      { value: "plugins", label: "Submit a plugin to the registry" },
    ],
  });

  if (clack.isCancel(choice)) {
    clack.cancel("Operation cancelled.");
    process.exit(0);
  }

  if (choice === "create") {
    await create(undefined, {});
    return;
  }
  if (choice === "upgrade") {
    await upgrade({});
    return;
  }
  if (choice === "plugins") {
    await submitPluginToRegistry(".", {
      registry: "elizaos-plugins/registry",
      base: "main",
    });
    return;
  }
  info({});
}

program
  .name("elizaos")
  .description("Create and upgrade elizaOS projects and plugins")
  .version(getCliVersion(), "-v, --version");

program
  .command("version")
  .description("Display version information")
  .action(version);

program
  .command("info")
  .description(
    "Display information about available project and plugin templates",
  )
  .option("-t, --template <template>", "Filter by template id or alias")
  .option("-l, --language <lang>", "Filter by language")
  .option("-j, --json", "Output as JSON")
  .action(info);

program
  .command("create")
  .description("Create a new elizaOS project or plugin")
  .argument("[name]", "Name for the new project directory")
  .option("-t, --template <template>", "Template to create")
  .option("-l, --language <lang>", "Template language")
  .option("-y, --yes", "Skip confirmation prompts")
  .option("--description <description>", "Plugin description override")
  .option("--github-username <username>", "Plugin GitHub username override")
  .option("--repo-url <url>", "Plugin repository URL override")
  .option("--skip-upstream", "Skip initializing the upstream eliza checkout")
  .action(create);

program
  .command("upgrade")
  .description("Upgrade the current generated project to the latest template")
  .option("--check", "Check what would change without writing files")
  .option("--dry-run", "Preview the upgrade without writing files")
  .option("--skip-upstream", "Skip updating the upstream eliza checkout")
  .action(upgrade);

registerPluginsCommand(program);

program.action(defaultAction);

await program.parseAsync();
