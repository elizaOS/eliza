#!/usr/bin/env bun

/**
 * Entrypoint for the Feed CLI (`bun apps/cli/src/index.ts`). Loads root `.env`
 * before any other import, then dispatches the first argv token to a domain
 * handler — db, admin, game, training, models, agents, status. Each domain
 * lives in `commands/`; this file owns only arg routing, help text, and the
 * Sentry init/flush wrapper around every run.
 */

import { resolve } from "node:path";
// Load environment variables from project root before any other imports
import { config } from "dotenv";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), ".env.local") });

import { captureCliExceptionAndFlush, initCliSentry } from "./sentry.js";

const VERSION = "0.2.0";

/**
 * Prints the main CLI help text with all available domains and commands.
 *
 * @internal
 */
function printHelp(): void {
  console.log(`
Feed CLI v${VERSION}

USAGE:
  feed <domain> <command> [options]

DOMAINS:
  db        Database management (start, stop, status, migrate, reset)
  admin     Admin user management (check, grant, revoke, list)
  status    System status (game, wallet, agent0, all)
  train     Training operations (list, pipeline, archetype, collect)
  model     Model management (list, upload, collect-data)
  game      Game control (start, pause, status, generate, validate)
  agent     Agent management (spawn, list, enable, disable)
  test      Load & stress testing (load, a2a)

EXAMPLES:
  feed db start                 Start PostgreSQL container
  feed db migrate               Run database migrations
  feed admin grant alice        Grant admin to user 'alice'
  feed status                   Show all system status
  feed game start               Start the continuous game
  feed game status              Check game runtime status
  feed train list               List available archetypes
  feed train pipeline -a trader Train trader archetype
  feed agent spawn --count 5    Spawn 5 test agents

OPTIONS:
  -h, --help      Show help for any command
  -v, --version   Show version number

Run 'feed <domain> --help' for domain-specific help.
`);
}

/**
 * Prints the CLI version number.
 *
 * @internal
 */
function printVersion(): void {
  console.log(`feed v${VERSION}`);
}

/**
 * Main entry point for the Feed CLI.
 *
 * Parses command-line arguments and routes to the appropriate domain handler.
 * Handles global flags (--help, --version) and delegates to domain-specific commands.
 *
 * @throws Exits process with code 1 on error, 0 on success
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const domain = args[0];
  const commandArgs = args.slice(1);

  if (!domain || domain === "-h" || domain === "--help") {
    printHelp();
    process.exit(0);
  }

  if (domain === "-v" || domain === "--version") {
    printVersion();
    process.exit(0);
  }

  initCliSentry({ domain, command: commandArgs[0] });

  switch (domain) {
    case "db":
      await (await import("./commands/db.js")).runDbCommand(commandArgs);
      break;

    case "admin":
      await (await import("./commands/admin.js")).runAdminCommand(commandArgs);
      break;

    case "status":
      await (await import("./commands/status.js")).runStatusCommand(
        commandArgs,
      );
      break;

    case "train":
      await (await import("./commands/train.js")).runTrainCommand(commandArgs);
      break;

    case "model":
      await (await import("./commands/model.js")).runModelCommand(commandArgs);
      break;

    case "game":
      await (await import("./commands/game.js")).runGameCommand(commandArgs);
      break;

    case "agent":
      await (await import("./commands/agent.js")).runAgentCommand(commandArgs);
      break;

    case "test":
      await (await import("./commands/test.js")).runTestCommand(commandArgs);
      break;

    default:
      console.error(`Unknown domain: ${domain}`);
      console.log("\nRun 'feed --help' for usage information.");
      process.exit(1);
  }
  process.exit(0);
}

if (import.meta.main) {
  main().catch(async (error) => {
    if (error instanceof Error && error.name === "CliUsageError") {
      console.error(error.message);
      process.exit(1);
      return;
    }

    await captureCliExceptionAndFlush(error, {
      domain: process.argv.slice(2)[0],
      command: process.argv.slice(3)[0],
    });
    console.error(error);
    process.exit(1);
  });
}

export { main };
