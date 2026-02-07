#!/usr/bin/env node
/**
 * elizaOS CLI
 * Create and manage elizaOS examples
 */

import { Command } from "commander";
import { create, info, version } from "./commands/index.js";

const program = new Command();

program
  .name("elizaos")
  .description("elizaOS CLI - Create and manage elizaOS examples")
  .version("1.0.0");

program
  .command("version")
  .description("Display version information")
  .action(version);

program
  .command("info")
  .description("Display information about available examples")
  .option(
    "-l, --language <lang>",
    "Filter by language (typescript, python, rust)",
  )
  .option("-j, --json", "Output as JSON")
  .action(info);

program
  .command("create")
  .description("Create a new elizaOS example project")
  .argument("[name]", "Name for the new project directory")
  .option("-l, --language <lang>", "Language (typescript, python, rust)")
  .option("-e, --example <example>", "Example to create")
  .option("-y, --yes", "Skip confirmation prompts")
  .action(create);

program.parse();
