import { existsSync, promises as fs } from "node:fs"
import path from "node:path"
import { getConfig, rawConfigSchema } from "@/src/utils/get-config"
import { handleError } from "@/src/utils/handle-error"
import { logger } from "@/src/utils/logger"
import { getAvailableDatabases, getRegistryIndex, listPluginsByType } from "@/src/utils/registry"
import { createDatabaseTemplate, createPluginsTemplate, createEnvTemplate } from "@/src/utils/templates"
import { runBunCommand } from "@/src/utils/run-bun"
import { installPlugin } from "@/src/utils/install-plugin"
import { copyTemplate } from "@/src/utils/copy-template"
import chalk from "chalk"
import { Command } from "commander"
import { execa } from "execa"
import prompts from "prompts"
import { z } from "zod"

const initOptionsSchema = z.object({
  dir: z.string().default("."),
  yes: z.boolean().default(false),
  type: z.enum(["project", "plugin"]).default("project")
})

async function setupEnvironment(targetDir: string, database: string) {
  const envPath = path.join(targetDir, ".env")
  const envExamplePath = path.join(targetDir, ".env.example")

  await fs.writeFile(envExamplePath, createEnvTemplate(database))

  if (!existsSync(envPath)) {
    await fs.copyFile(envExamplePath, envPath)
    logger.info("Created .env file")
  }
}

async function selectPlugins() {
  
  const clients = await listPluginsByType("client")
  const plugins = await listPluginsByType("plugin")

  const result = await prompts([
    {
      type: "multiselect",
      name: "clients",
      message: "Select client plugins to install",
      choices: clients.map(name => ({
        title: name,
        value: name
      }))
    },
    {
      type: "multiselect", 
      name: "plugins",
      message: "Select additional plugins",
      choices: plugins.map(name => ({
        title: name,
        value: name
      }))
    }
  ])

  return [...result.clients, ...result.plugins]
}

async function installDependencies(targetDir: string, database: string, selectedPlugins: string[]) {
  logger.info("Installing dependencies...")

  // Install bun if not already installed
  await execa("npm", ["install", "-g", "bun"], {
    stdio: "inherit"
  })

  // Use bun for installation
  await runBunCommand(["install", "--no-frozen-lockfile"], targetDir);
  await runBunCommand(["add", `@elizaos/adapter-${database}`, "--workspace-root"], targetDir);

  if (selectedPlugins.length > 0) {
    console.log(selectedPlugins)
    for (const plugin of selectedPlugins) {
      await installPlugin(plugin, targetDir)
    }
  }
}

export const init = new Command()
  .name("init")
  .description("Initialize a new project or plugin")
  .option("-d, --dir <dir>", "installation directory", ".")
  .option("-y, --yes", "skip confirmation", false)
  .option("-t, --type <type>", "type of template to use (project or plugin)", "project")
  .action(async (opts) => {
    try {
      const options = initOptionsSchema.parse(opts)

      // Prompt for project/plugin name
      const { name } = await prompts({
        type: "text",
        name: "name",
        message: `What would you like to name your ${options.type}?`,
        validate: value => value.length > 0 || `${options.type} name is required`
      })

      if (!name) {
        process.exit(0)
      }

      // Set up target directory
      const targetDir = options.dir === "." ? 
        path.resolve(name) : 
        path.resolve(options.dir)

      // Create or check directory
      if (!existsSync(targetDir)) {
        await fs.mkdir(targetDir, { recursive: true })
      } else {
        const files = await fs.readdir(targetDir)
        const isEmpty = files.length === 0 || files.every(f => f.startsWith("."))

        if (!isEmpty && !options.yes) {
          const { proceed } = await prompts({
            type: "confirm",
            name: "proceed",
            message: "Directory is not empty. Continue anyway?",
            initial: false
          })

          if (!proceed) {
            process.exit(0)
          }
        }
      }

      // For plugin initialization, we can simplify the process
      if (options.type === "plugin") {
        // Copy plugin template
        await copyTemplate("plugin", targetDir, name)
        
        // Change directory and install dependencies
        logger.info("Installing dependencies...")
        try {
          await runBunCommand(["install"], targetDir);
          logger.success("Dependencies installed successfully!");
        } catch (_error) {
          logger.warn("Failed to install dependencies automatically. Please run 'bun install' manually.");
        }
        
        logger.success("Plugin initialized successfully!")
        logger.info(`\nNext steps:
1. ${chalk.cyan(`cd ${name}`)} to navigate to your plugin directory
2. Update the plugin code in ${chalk.cyan("src/index.ts")} 
3. Run ${chalk.cyan("bun dev")} to start development
4. Run ${chalk.cyan("bun build")} to build your plugin`)
        return
      }

      // For project initialization, continue with the regular flow
      // Get available databases and select one
      const availableDatabases = await getAvailableDatabases()
      
      const { database } = await prompts({
        type: "select",
        name: "database",
        message: "Select your database:",
        choices: availableDatabases.map(db => ({
          title: db,
          value: db
        })),
        initial: availableDatabases.indexOf("postgres")
      })

      if (!database) {
        logger.error("No database selected")
        process.exit(1)
      }

      // Select plugins
      const selectedPlugins = await selectPlugins()

      // Copy project template
      await copyTemplate("project", targetDir, name)

      // Create project configuration
      const config = rawConfigSchema.parse({
        $schema: "https://elizaos.com/schema.json",
        database: {
          type: database,
          config: database === "postgres" ? {
            url: process.env.POSTGRES_URL || ""
          } : {
            path: "../../pglite"
          }
        },
        plugins: {
          registry: "https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/main/index.json",
          installed: [`@elizaos/plugin-${database}`, ...selectedPlugins]
        },
        paths: {
          knowledge: "./knowledge"
        }
      })

      // Write configuration
      await fs.writeFile(
        path.join(targetDir, "project.json"),
        JSON.stringify(config, null, 2)
      )

      // Set up src directory
      const srcDir = path.join(targetDir, "src")
      if (!existsSync(srcDir)) {
        await fs.mkdir(srcDir)
      }

      // Generate database and plugin files
      await fs.writeFile(
        path.join(srcDir, "database.ts"),
        createDatabaseTemplate(database)
      )

      await fs.writeFile(
        path.join(srcDir, "plugins.ts"),
        createPluginsTemplate(selectedPlugins)
      )

      // Set up environment
      await setupEnvironment(targetDir, database)

      // Create knowledge directory
      await fs.mkdir(path.join(targetDir, "knowledge"), { recursive: true })

      // Install dependencies
      await installDependencies(targetDir, database, selectedPlugins)

      logger.success("Project initialized successfully!")

      // Show next steps
      if (database !== "postgres") {
        logger.info(`\nNext steps:
1. ${chalk.cyan(`cd ${name}`)} to navigate to your project directory
2. Update ${chalk.cyan(".env")} with your database credentials
3. Run ${chalk.cyan("eliza plugins add")} to install additional plugins
4. Run ${chalk.cyan("eliza agent import")} to import an agent`)
      } else {
        logger.info(`\nNext steps:
1. ${chalk.cyan(`cd ${name}`)} to navigate to your project directory
2. Run ${chalk.cyan("eliza plugins add")} to install additional plugins
3. Run ${chalk.cyan("eliza agent import")} to import an agent`)
      }

    } catch (error) {
      handleError(error)
    }
  })