import { getConfig } from "@/src/utils/get-config";
import { handleError } from "@/src/utils/handle-error";
import { logger } from "@/src/utils/logger";
import { getPluginRepository, getRegistryIndex } from "@/src/utils/registry";
import { Command } from "commander";
import { execa } from "execa";
import { installPlugin } from "@/src/utils/install-plugin";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import prompts from "prompts";
import { copyTemplate } from "@/src/utils/copy-template";
import chalk from "chalk";
import { runBunCommand } from "@/src/utils/run-bun";

export const plugins = new Command()
	.name("plugins")
	.description("manage ElizaOS plugins");

plugins
	.command("list")
	.description("list available plugins")
	.option("-t, --type <type>", "filter by type (adapter, client, plugin)")
	.action(async (opts) => {
		try {
			const registry = await getRegistryIndex();
			const plugins = Object.keys(registry)
				.filter((name) => !opts.type || name.includes(opts.type))
				.sort();

			logger.info("\nAvailable plugins:");
			for (const plugin of plugins) {
				logger.info(`  ${plugin}`);
			}
			logger.info("");
		} catch (error) {
			handleError(error);
		}
	});

plugins
	.command("add")
	.description("add a plugin")
	.argument("<plugin>", "plugin name")
	.action(async (plugin, _opts) => {
		try {
			const cwd = process.cwd();

			const config = await getConfig(cwd);
			if (!config) {
				logger.error("No project.json found. Please run init first.");
				process.exit(1);
			}

			const repo = await getPluginRepository(plugin);

			if (!repo) {
				logger.error(`Plugin ${plugin} not found in registry`);
				process.exit(1);
			}

			// Add to config
			if (!config.plugins.installed.includes(plugin)) {
				config.plugins.installed.push(plugin);
			}

			// Install from GitHub
			logger.info(`Installing ${plugin}...`);
			await installPlugin(repo, cwd);

			logger.success(`Successfully installed ${plugin}`);
		} catch (error) {
			handleError(error);
		}
	});

plugins
	.command("remove")
	.description("remove a plugin")
	.argument("<plugin>", "plugin name")
	.action(async (plugin, _opts) => {
		try {
			const cwd = process.cwd();

			const config = await getConfig(cwd);
			if (!config) {
				logger.error("No project.json found. Please run init first.");
				process.exit(1);
			}

			// Remove from config
			config.plugins.installed = config.plugins.installed.filter(
				(p) => p !== plugin,
			);

			// Uninstall package
			logger.info(`Removing ${plugin}...`);
			await execa("bun", ["remove", plugin], {
				cwd,
				stdio: "inherit",
			});

			logger.success(`Successfully removed ${plugin}`);
		} catch (error) {
			handleError(error);
		}
	});

plugins
	.command("update")
	.description("update plugins")
	.option("-p, --plugin <plugin>", "specific plugin to update")
	.action(async (opts) => {
		try {
			const cwd = process.cwd();

			const config = await getConfig(cwd);
			if (!config) {
				logger.error("No project.json found. Please run init first.");
				process.exit(1);
			}

			const _registry = await getRegistryIndex();
			const plugins = opts.plugin ? [opts.plugin] : config.plugins.installed;

			for (const plugin of plugins) {
				const repo = await getPluginRepository(plugin);
				if (!repo) {
					logger.warn(`Plugin ${plugin} not found in registry, skipping`);
					continue;
				}

				logger.info(`Updating ${plugin}...`);
				await execa("bun", ["update", plugin], {
					cwd,
					stdio: "inherit",
				});
			}

			logger.success("Plugins updated successfully");
		} catch (error) {
			handleError(error);
		}
	});

plugins
	.command("create")
	.description("create a new plugin")
	.option("-d, --dir <dir>", "installation directory", ".")
	.action(async (opts) => {
		try {
			// Prompt for plugin name
			const { name } = await prompts({
				type: "text",
				name: "name",
				message: "What would you like to name your plugin?",
				validate: (value) => value.length > 0 || "Plugin name is required",
			});

			if (!name) {
				process.exit(0);
			}

			// Set up target directory
			const targetDir =
				opts.dir === "." ? path.resolve(name) : path.resolve(opts.dir);

			// Create or check directory
			if (!existsSync(targetDir)) {
				await fs.mkdir(targetDir, { recursive: true });
			} else {
				const files = await fs.readdir(targetDir);
				const isEmpty =
					files.length === 0 || files.every((f) => f.startsWith("."));

				if (!isEmpty) {
					const { proceed } = await prompts({
						type: "confirm",
						name: "proceed",
						message: "Directory is not empty. Continue anyway?",
						initial: false,
					});

					if (!proceed) {
						process.exit(0);
					}
				}
			}

			const pluginName = name.startsWith("@elizaos/plugin-")
				? name
				: `@elizaos/plugin-${name}`;

			// Copy plugin template
			await copyTemplate("plugin", targetDir, pluginName);

			// Install dependencies
			logger.info("Installing dependencies...");
			try {
				await runBunCommand(["install"], targetDir);
				logger.success("Dependencies installed successfully!");
			} catch (_error) {
				logger.warn(
					"Failed to install dependencies automatically. Please run 'bun install' manually.",
				);
			}

			logger.success("Plugin created successfully!");
			logger.info(`\nNext steps:
1. ${chalk.cyan(`cd ${name}`)} to navigate to your plugin directory
2. Update the plugin code in ${chalk.cyan("src/index.ts")} 
3. Run ${chalk.cyan("bun dev")} to start development
4. Run ${chalk.cyan("bun build")} to build your plugin`);
		} catch (error) {
			handleError(error);
		}
	});
