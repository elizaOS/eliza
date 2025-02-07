#!/usr/bin/env bun
import { init } from "@/src/commands/init"
import { plugins } from "@/src/commands/plugins"
// import { agent } from "@/src/commands/agent"
import { Command } from "commander"
import { logger } from "@/src/utils/logger"
import { teeCommand as tee } from "@/src/commands/tee"

process.on("SIGINT", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))

console.log("Hello World")

async function main() {
  const program = new Command()
    .name("eliza")
    .description("elizaOS CLI - Manage your AI agents and plugins")
    .version("1.0.0")

  program
    .addCommand(init)
    .addCommand(plugins)
    // .addCommand(agent)
    .addCommand(tee)
  program.parse(process.argv)
}

main().catch((error) => {
  logger.error("An error occurred:", error)
  process.exit(1)
})