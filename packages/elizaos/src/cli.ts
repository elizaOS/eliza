#!/usr/bin/env node
/**
 * Commander entrypoint for the `elizaos` binary and its interactive default
 * menu. Command implementations stay in `src/commands` so tests can invoke the
 * same logic without booting the CLI parser.
 */

import * as clack from "@clack/prompts";
import { Command } from "commander";
import {
  capabilityRouterConnect,
  create,
  DEPLOY_COMMAND_DESCRIPTION,
  DEPLOY_DRY_RUN_DESCRIPTION,
  deploy,
  info,
  migrateAgent,
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

program
  .command("deploy")
  .description(DEPLOY_COMMAND_DESCRIPTION)
  .option("--app-id <id>", "Eliza Cloud app UUID to include in the plan")
  .option("--domain <host>", "Custom domain to include in the plan")
  .option("--dry-run", DEPLOY_DRY_RUN_DESCRIPTION)
  .option("--verbose", "Echo resolved deploy inputs to stderr")
  .action(deploy);

program
  .command("migrate-agent")
  .description(
    "Migrate a file-based OpenClaw agent (SOUL/IDENTITY/memory) onto Eliza",
  )
  .requiredOption("--from <home>", "OpenClaw agent home, e.g. ~/.moltbot")
  .requiredOption("--agent-id <slug>", "Agent slug, e.g. sol")
  .option("--out <file>", "Write an encrypted .eliza-agent archive")
  .option("--password <pw>", "Archive encryption password (min 8 chars)")
  .option(
    "--memory-days <n>",
    "Days of daily logs to seed verbatim (default 14)",
  )
  .option(
    "--no-firewall",
    "Include USER/personal knowledge (owner-local only!)",
  )
  .option(
    "--current-context <text>",
    "Live-context block for the system prompt",
  )
  .option(
    "--emit-character <file>",
    "Emit character JSON (sovereign-local path)",
  )
  .option(
    "--emit-memories <file>",
    "Emit memories JSONL (sovereign-local path)",
  )
  .option("--dry-run", "Print the plan, write nothing")
  .option("-j, --json", "Output the plan as JSON")
  .action(migrateAgent);

registerPluginsCommand(program);

const capabilityRouter = program
  .command("capability-router")
  .description("Manage dynamic capability-router endpoints");

capabilityRouter
  .command("connect")
  .description(
    "Connect the running agent to a remote capability-router endpoint or Cloud sandbox",
  )
  .option("--api-base <url>", "Agent API base URL")
  .option("--api-token <token>", "Agent API bearer token")
  .option("--endpoint-url <url>", "Existing capability-router endpoint URL")
  .option("--endpoint-id <id>", "Endpoint id to register")
  .option("--endpoint-token <token>", "Bearer token for the endpoint")
  .option("--cloud-api-base <url>", "Eliza Cloud API base URL")
  .option("--cloud-auth-token <token>", "Eliza Cloud bearer token")
  .option("--cloud-agent-name <name>", "Name for the provisioned Cloud agent")
  .option("--cloud-bio <line...>", "Bio lines for the provisioned Cloud agent")
  .option(
    "--cloud-endpoint-token <token>",
    "Override token used to call the provisioned endpoint",
  )
  .option(
    "--allowed-module <id...>",
    "Remote module id(s) allowed to register from the connected endpoint",
  )
  .option(
    "--keep-missing",
    "Keep previously synced remote plugins missing from the endpoint",
  )
  .option("--no-persist", "Connect for this running agent only")
  .option(
    "--request-timeout-ms <ms>",
    "Capability request timeout in milliseconds",
  )
  .option(
    "--provision-timeout-ms <ms>",
    "Cloud provisioning timeout in milliseconds",
  )
  .option(
    "--poll-interval-ms <ms>",
    "Cloud provisioning poll interval in milliseconds",
  )
  .option("-j, --json", "Output JSON")
  .action(capabilityRouterConnect);

program.action(defaultAction);

await program.parseAsync();
