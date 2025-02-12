import { getConfig } from "@/src/utils/get-config"
import { handleError } from "@/src/utils/handle-error"
import { logger } from "@/src/utils/logger"
import { Command } from "commander"

export const agentPlugin = new Command()
  .name("plugin")
  .description("manage agent plugins")

agentPlugin
  .command("list")
  .description("list plugins for an agent")
  .argument("<agent-id>", "agent ID")
  .action(async (agentId) => {
    try {
      const cwd = process.cwd()
      const config = await getConfig(cwd)
      if (!config) {
        logger.error("No project.json found. Please run init first.")
        process.exit(1)
      }
      
      // load all agents from databaseAdapter


    } catch (error) {
      handleError(error)
    }
  })

agentPlugin
  .command("add")
  .description("add plugin to an agent")
  .argument("<agent-id>", "agent ID")
  .argument("<plugin>", "plugin name")
  .action(async (agentId, pluginName) => {
    try {
      const cwd = process.cwd()
      const config = await getConfig(cwd)
      if (!config) {
        logger.error("No project.json found. Please run init first.")
        process.exit(1)
      }

      // TODO: Do something here

    } catch (error) {
      handleError(error)
    }
  })

agentPlugin
  .command("remove")
  .description("remove plugin from an agent")
  .argument("<agent-id>", "agent ID")
  .argument("<plugin>", "plugin name")
  .action(async (agentId, pluginName) => {
    try {
      const cwd = process.cwd()
      const config = await getConfig(cwd)
      if (!config) {
        logger.error("No project.json found. Please run init first.")
        process.exit(1)
      }

      // TODO: Some stuff here

    } catch (error) {
      handleError(error)
    }
  })

export default agentPlugin