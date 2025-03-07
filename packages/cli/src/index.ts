#!/usr/bin/env node
import { init } from "@/src/commands/init"
import { plugins } from "@/src/commands/plugins"
import { Command } from "commander"
import { logger } from "@/src/utils/logger"
import { teeCommand as tee } from "@/src/commands/tee"
import { agent } from "@/src/commands/agent"
import { start } from "@/src/commands/start"
import { loadEnvironment } from "@/src/utils/get-config"

process.on("SIGINT", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))

async function main() {
  // Load environment variables, trying project .env first, then global ~/.eliza/.env
  await loadEnvironment();
  
  const program = new Command()
    .name("eliza")
    .description("elizaOS CLI - Manage your AI agents and plugins")
    .version("1.0.0")

  program
    .addCommand(init)
    .addCommand(plugins)
    .addCommand(agent)
    .addCommand(tee)
    .addCommand(start)
  program.parse(process.argv)
}

main().catch((error) => {
  logger.error("An error occurred:", error)
  process.exit(1)
})