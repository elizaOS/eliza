import { getConfig } from "@/src/utils/get-config"
import { handleError } from "@/src/utils/handle-error"
import { logger } from "@/src/utils/logger"
import { getPluginRepository, getRegistryIndex } from "@/src/utils/registry"
import { Command } from "commander"
import { execa } from "execa"

export const plugins = new Command()
  .name("plugins")
  .description("manage ElizaOS plugins")

plugins
  .command("list")
  .description("list available plugins")
  .option("-t, --type <type>", "filter by type (adapter, client, plugin)")
  .action(async (opts) => {
    try {
      const registry = await getRegistryIndex()
      const plugins = Object.keys(registry)
        .filter(name => !opts.type || name.includes(opts.type))
        .sort()

      logger.info("\nAvailable plugins:")
      for (const plugin of plugins) {
        logger.info(`  ${plugin}`)
      }
      logger.info("")
    } catch (error) {
      handleError(error) 
    }
  })

plugins
  .command("add")
  .description("add a plugin")
  .argument("<plugin>", "plugin name")
  .action(async (plugin, opts) => {
    try {
      const cwd = process.cwd()
      
      const config = await getConfig(cwd)
      if (!config) {
        logger.error("No project.json found. Please run init first.")
        process.exit(1)
      }

      const repo = await getPluginRepository(plugin)

      if (!repo) {
        logger.error(`Plugin ${plugin} not found in registry`)
        process.exit(1)
      }

      // Add to config
      if (!config.plugins.installed.includes(plugin)) {
        config.plugins.installed.push(plugin)
      }

      // Install from GitHub
      logger.info(`Installing ${plugin}...`)
      await execa("bun", ["add", repo], {
        cwd,
        stdio: "inherit"
      })

      logger.success(`Successfully installed ${plugin}`)

    } catch (error) {
      handleError(error)
    }
  })

plugins
  .command("remove") 
  .description("remove a plugin")
  .argument("<plugin>", "plugin name")
  .action(async (plugin, opts) => {
    try {
      const cwd = process.cwd()
      
      const config = await getConfig(cwd)
      if (!config) {
        logger.error("No project.json found. Please run init first.")
        process.exit(1)
      }

      // Remove from config
      config.plugins.installed = config.plugins.installed.filter(p => p !== plugin)

      // Uninstall package
      logger.info(`Removing ${plugin}...`)
      await execa("bun", ["remove", plugin], {
        cwd,
        stdio: "inherit" 
      })

      logger.success(`Successfully removed ${plugin}`)

    } catch (error) {
      handleError(error)
    }
  })

plugins
  .command("update")
  .description("update plugins")
  .option("-p, --plugin <plugin>", "specific plugin to update") 
  .action(async (opts) => {
    try {
      const cwd = process.cwd()
      
      const config = await getConfig(cwd)
      if (!config) {
        logger.error("No project.json found. Please run init first.")
        process.exit(1)
      }

      const registry = await getRegistryIndex()
      const plugins = opts.plugin 
        ? [opts.plugin]
        : config.plugins.installed

      for (const plugin of plugins) {
        const repo = await getPluginRepository(plugin)
        if (!repo) {
          logger.warn(`Plugin ${plugin} not found in registry, skipping`)
          continue
        }

        logger.info(`Updating ${plugin}...`)
        await execa("bun", ["update", plugin], {
          cwd,
          stdio: "inherit"
        })
      }

      logger.success("Plugins updated successfully")

    } catch (error) {
      handleError(error)
    }
  })