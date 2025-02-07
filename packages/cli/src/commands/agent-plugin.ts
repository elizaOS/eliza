import { getConfig } from "@/src/utils/get-config"
import { handleError } from "@/src/utils/handle-error"
import { logger } from "@/src/utils/logger"
import { getPluginRepository, getRegistryIndex } from "@/src/utils/registry"
import { Database, SqliteDatabaseAdapter } from "@elizaos-plugins/sqlite"
import { Command } from "commander"
import { execa } from "execa"

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

      // Initialize DB adapter
      const db = new Database((config.database.config as any).path)
      const adapter = new SqliteDatabaseAdapter(db)
      await adapter.init()

      // Get agent
      const account = await adapter.getAccountById(agentId)
      if (!account) {
        logger.error(`Agent ${agentId} not found`)
        process.exit(1)
      }

      const plugins = account.details?.plugins || []

      if (plugins.length === 0) {
        logger.info(`No plugins installed for agent ${account.name}`)
      } else {
        logger.info(`\nPlugins for agent ${account.name}:`)
        for (const plugin of plugins) {
          logger.info(`  ${plugin}`)
        }
      }

      await adapter.close()
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

      // Check if plugin exists in registry
      const registry = await getRegistryIndex(config.plugins.registry)
      const repo = await getPluginRepository(pluginName)
      if (!repo) {
        logger.error(`Plugin ${pluginName} not found in registry`)
        process.exit(1)
      }

      // Initialize DB adapter
      const db = new Database(config.database.config.path)
      const adapter = new SqliteDatabaseAdapter(db)
      await adapter.init()

      // Get agent
      const account = await adapter.getAccountById(agentId)
      if (!account) {
        logger.error(`Agent ${agentId} not found`)
        process.exit(1)
      }

      // Update agent plugins
      const plugins = new Set(account.details?.plugins || [])
      if (plugins.has(pluginName)) {
        logger.warn(`Plugin ${pluginName} is already installed for agent ${account.name}`)
        process.exit(0)
      }

      plugins.add(pluginName)

      // Update agent account
      await adapter.updateAccount({
        ...account,
        details: {
          ...account.details,
          plugins: Array.from(plugins)
        }
      })

      // Install plugin package if not already installed
      if (!config.plugins.installed.includes(pluginName)) {
        logger.info(`Installing ${pluginName}...`)
        await execa("bun", ["add", repo], {
          cwd,
          stdio: "inherit"
        })
        config.plugins.installed.push(pluginName)
      }

      logger.success(`Added plugin ${pluginName} to agent ${account.name}`)

      await adapter.close()
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

      // Initialize DB adapter
      const db = new Database(config.database.config.path)
      const adapter = new SqliteDatabaseAdapter(db)
      await adapter.init()

      // Get agent
      const account = await adapter.getAccountById(agentId)
      if (!account) {
        logger.error(`Agent ${agentId} not found`)
        process.exit(1)
      }

      // Update agent plugins
      const plugins = new Set(account.details?.plugins || [])
      if (!plugins.has(pluginName)) {
        logger.warn(`Plugin ${pluginName} is not installed for agent ${account.name}`)
        process.exit(0)
      }

      plugins.delete(pluginName)

      // Update agent account
      await adapter.updateAccount({
        ...account,
        details: {
          ...account.details,
          plugins: Array.from(plugins)
        }
      })

      // Check if plugin is still used by other agents
      const allAgents = await adapter.getAgents()
      const stillInUse = allAgents.some(other => 
        other.id !== agentId && 
        other.details?.plugins?.includes(pluginName)
      )

      // If plugin is not used by any other agent, remove it
      if (!stillInUse) {
        logger.info(`Removing unused plugin ${pluginName}...`)
        await execa("bun", ["remove", pluginName], {
          cwd,
          stdio: "inherit"
        })
        config.plugins.installed = config.plugins.installed.filter(p => p !== pluginName)
      }

      logger.success(`Removed plugin ${pluginName} from agent ${account.name}`)

      await adapter.close()
    } catch (error) {
      handleError(error)
    }
  })

export default agentPlugin