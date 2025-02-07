import { existsSync, promises as fs } from "fs"
import path from "node:path"
import { getConfig, rawConfigSchema } from "@/src/utils/get-config"
import { handleError } from "@/src/utils/handle-error"
import { logger } from "@/src/utils/logger"
import { getAvailableDatabases, getRegistryIndex, listPluginsByType } from "@/src/utils/registry"
import { createDatabaseTemplate, createPluginsTemplate, createEnvTemplate } from "@/src/utils/templates"
import chalk from "chalk"
import { Command } from "commander"
import { execa } from "execa"
import prompts from "prompts"
import { z } from "zod"

const initOptionsSchema = z.object({
  dir: z.string().default("."),
  yes: z.boolean().default(false)
})

async function cloneStarterRepo(targetDir: string) {
  logger.info("Setting up project structure...")
  await execa("git", ["clone", "-b", "develop", "https://github.com/elizaos/eliza", "."], {
    cwd: targetDir,
    stdio: "inherit",
  })
}

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
  const registry = await getRegistryIndex()
  
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

  // Install pnpm if not already installed
  await execa("npm", ["install", "-g", "pnpm"], {
    stdio: "inherit"
  })

  // Use pnpm for installation
  await execa("pnpm", ["install", "--no-frozen-lockfile"], { 
    cwd: targetDir, 
    stdio: "inherit" 
  })

  await execa("pnpm", ["add", `@elizaos/adapter-${database}`, "--workspace-root"], {
    cwd: targetDir,
    stdio: "inherit"
  })

  if (selectedPlugins.length > 0) {
    console.log(selectedPlugins)
    await execa("pnpm", ["add", ...selectedPlugins, "--workspace-root"], {
      cwd: targetDir,
      stdio: "inherit"
    })
  }
}

export const init = new Command()
  .name("init")
  .description("Initialize a new project")
  .option("-d, --dir <dir>", "installation directory", ".")
  .option("-y, --yes", "skip confirmation", false)
  .action(async (opts) => {
    try {
      const options = initOptionsSchema.parse(opts)

      // Prompt for project name
      const { name } = await prompts({
        type: "text",
        name: "name",
        message: "What would you like to name your project?",
        validate: value => value.length > 0 || "Project name is required"
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
        initial: availableDatabases.indexOf("sqlite")
      })

      if (!database) {
        logger.error("No database selected")
        process.exit(1)
      }

      // Select plugins
      const selectedPlugins = await selectPlugins()

      // Clone starter repository
      await cloneStarterRepo(targetDir)

      // Create project configuration
      const config = rawConfigSchema.parse({
        $schema: "https://elizaos.com/schema.json",
        database: {
          type: database,
          config: database === "sqlite" ? {
            path: "./eliza.db"
          } : {
            url: process.env.DATABASE_URL || ""
          }
        },
        plugins: {
          registry: "https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/main/index.json",
          installed: [`@elizaos/adapter-${database}`, ...selectedPlugins]
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

      // Install dependencies
      await installDependencies(targetDir, database, selectedPlugins)

      // Create knowledge directory
      await fs.mkdir(path.join(targetDir, "knowledge"), { recursive: true })

      logger.success("Project initialized successfully!")

      // Show next steps
      if (database !== "sqlite") {
        logger.info(`\nNext steps:
1. Update ${chalk.cyan(".env")} with your database credentials
2. Run ${chalk.cyan("eliza plugins add")} to install additional plugins
3. Run ${chalk.cyan("eliza agent import")} to import an agent`)
      } else {
        logger.info(`\nNext steps:
1. Run ${chalk.cyan("eliza plugins add")} to install additional plugins
2. Run ${chalk.cyan("eliza agent import")} to import an agent`)
      }

    } catch (error) {
      handleError(error)
    }
  })