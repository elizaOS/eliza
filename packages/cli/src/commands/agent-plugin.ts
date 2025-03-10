import { Command } from "commander";
import { logger } from "@elizaos/core";
import { loadProject } from "../project.js";

export const agentPlugin = new Command("plugin")
	.description("Manage plugins for an agent")
	.argument("<agentId>", "The ID of the agent to manage plugins for")
	.option("-a, --add <plugin>", "Add a plugin to the agent")
	.option("-r, --remove <plugin>", "Remove a plugin from the agent")
	.option("-l, --list", "List all plugins for the agent")
	.option("-p, --project <path>", "Path to the project directory", ".")
	.action(async (agentId, options) => {
		try {
			const project = await loadProject(options.project);
			if (!project) {
				throw new Error("Failed to load project");
			}

			if (options.list) {
				const plugins = project.runtime.plugins;
				logger.info("Installed plugins:");
				plugins.forEach((plugin) => {
					logger.info(`- ${plugin.name}`);
				});
			} else if (options.add) {
				logger.info(`Adding plugin ${options.add} to agent ${agentId}`);
				// TODO: Implement plugin installation
			} else if (options.remove) {
				logger.info(`Removing plugin ${options.remove} from agent ${agentId}`);
				// TODO: Implement plugin removal
			}
		} catch (error) {
			logger.error("Error managing plugins:", error);
			process.exit(1);
		}
	});
