import { buildProject } from "@/src/utils/build-project";
import {
	AgentRuntime,
	type Character,
	type IAgentRuntime,
	ModelTypes,
	type Plugin,
	logger,
	settings,
	stringToUuid
} from "@elizaos/core";
import { Command } from "commander";
import * as dotenv from "dotenv";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { character as defaultCharacter } from "../characters/eliza";
import { AgentServer } from "../server/index";
import { jsonToCharacter, loadCharacterTryPath } from "../server/loader";
import {
	displayConfigStatus,
	loadConfig,
	saveConfig
} from "../utils/config-manager.js";
import {
	promptForEnvVars,
} from "../utils/env-prompt.js";
import { handleError } from "../utils/handle-error";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const wait = (minTime = 1000, maxTime = 3000) => {
	const waitTime =
		Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
	return new Promise((resolve) => setTimeout(resolve, waitTime));
};

/**
 * Analyzes project agents and their plugins to determine which environment variables to prompt for
 */
export async function promptForProjectPlugins(
	project: any,
	pluginToLoad?: { name: string },
): Promise<void> {
	// Set to track unique plugin names to avoid duplicate prompts
	const pluginsToPrompt = new Set<string>();

	// If we have a specific plugin to load, add it
	if (pluginToLoad?.name) {
		pluginsToPrompt.add(pluginToLoad.name.toLowerCase());
	}

	// If we have a project, scan all its agents for plugins
	if (project) {
		// Handle both formats: project with agents array and project with single agent
		const agents = Array.isArray(project.agents)
			? project.agents
			: project.agent
				? [project.agent]
				: [];

		// Check each agent's plugins
		for (const agent of agents) {
			if (agent.plugins?.length) {
				for (const plugin of agent.plugins) {
					const pluginName = typeof plugin === "string" ? plugin : plugin.name;

					if (pluginName) {
						// Extract just the plugin name from the package name if needed
						const simpleName =
							pluginName.split("/").pop()?.replace("plugin-", "") || pluginName;
						pluginsToPrompt.add(simpleName.toLowerCase());
					}
				}
			}
		}
	}

	// Prompt for each identified plugin
	for (const pluginName of pluginsToPrompt) {
		try {
			await promptForEnvVars(pluginName);
		} catch (error) {
			logger.warn(
				`Failed to prompt for ${pluginName} environment variables: ${error}`,
			);
		}
	}
}

/**
 * Starts an agent with the given character, agent server, initialization function, plugins, and options.
 *
 * @param character The character object representing the agent.
 * @param server The agent server where the agent will be registered.
 * @param init Optional initialization function to be called with the agent runtime.
 * @param plugins An array of plugins to be used by the agent.
 * @param options Additional options for starting the agent, such as data directory and postgres URL.
 * @returns A promise that resolves to the agent runtime object.
 */
async function startAgent(
	character: Character,
	server: AgentServer,
	init?: (runtime: IAgentRuntime) => void,
	plugins: Plugin[] = [],
	options: {
		dataDir?: string;
		postgresUrl?: string;
		isPluginTestMode?: boolean;
	} = {},
): Promise<IAgentRuntime> {
	character.id ??= stringToUuid(character.name);

	const runtime = new AgentRuntime({
		character,
		plugins,
	});
	if (init) {
		await init(runtime);
	}

	// start services/plugins/process knowledge
	await runtime.initialize();

	// Check if TEXT_EMBEDDING model is registered, if not, try to load one
	// Skip auto-loading embedding models if we're in plugin test mode
	const embeddingModel = runtime.getModel(ModelTypes.TEXT_EMBEDDING);
	if (!embeddingModel && !options.isPluginTestMode) {
		logger.info("No TEXT_EMBEDDING model registered. Attempting to load one automatically...");
		
		// First check if OpenAI API key exists
		if (process.env.OPENAI_API_KEY) {
			logger.info("Found OpenAI API key. Loading OpenAI plugin for embeddings...");
			
			try {
				// Use Node's require mechanism to dynamically load the plugin
				const pluginName = "@elizaos/plugin-openai";
				
				try {
					// Using require for dynamic imports in Node.js is safer than eval
					// This is a CommonJS approach that works in Node.js
					// @ts-ignore - Ignoring TypeScript's static checking for dynamic requires
					const pluginModule = require(pluginName);
					const plugin = pluginModule.default || pluginModule.openaiPlugin;
					
					if (plugin) {
						await runtime.registerPlugin(plugin);
						logger.success("Successfully loaded OpenAI plugin for embeddings");
					} else {
						logger.warn(`Could not find a valid plugin export in ${pluginName}`);
					}
				} catch (error) {
					logger.warn(`Failed to import OpenAI plugin: ${error}`);
					logger.warn(`You may need to install it with: npm install ${pluginName}`);
				}
			} catch (error) {
				logger.warn(`Error loading OpenAI plugin: ${error}`);
			}
		} else {
			logger.info("No OpenAI API key found. Loading local-ai plugin for embeddings...");
			
			try {
				// Use Node's require mechanism to dynamically load the plugin
				const pluginName = "@elizaos/plugin-local-ai";
				
				try {
					// Using require for dynamic imports in Node.js is safer than eval
					// @ts-ignore - Ignoring TypeScript's static checking for dynamic requires
					const pluginModule = require(pluginName);
					const plugin = pluginModule.default || pluginModule.localAIPlugin;
					
					if (plugin) {
						await runtime.registerPlugin(plugin);
						logger.success("Successfully loaded local-ai plugin for embeddings");
					} else {
						logger.warn(`Could not find a valid plugin export in ${pluginName}`);
					}
				} catch (error) {
					logger.warn(`Failed to import local-ai plugin: ${error}`);
					logger.warn(`You may need to install it with: npm install ${pluginName}`);
				}
			} catch (error) {
				logger.warn(`Error loading local-ai plugin: ${error}`);
			}
		}
	} else if (!embeddingModel && options.isPluginTestMode) {
		logger.info("No TEXT_EMBEDDING model registered, but running in plugin test mode - skipping auto-loading");
	}

	// add to container
	server.registerAgent(runtime);

	// report to console
	logger.debug(`Started ${runtime.character.name} as ${runtime.agentId}`);

	return runtime;
}

/**
 * Stops the agent by closing the database adapter and unregistering the agent from the server.
 *
 * @param {IAgentRuntime} runtime - The runtime of the agent.
 * @param {AgentServer} server - The server that the agent is registered with.
 * @returns {Promise<void>} - A promise that resolves once the agent is stopped.
 */
async function stopAgent(runtime: IAgentRuntime, server: AgentServer) {
	await runtime.close();
	server.unregisterAgent(runtime.agentId);
}

/**
 * Check if a port is available for listening.
 *
 * @param {number} port - The port number to check availability for.
 * @returns {Promise<boolean>} A Promise that resolves to true if the port is available, and false if it is not.
 */
const checkPortAvailable = (port: number): Promise<boolean> => {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE") {
				resolve(false);
			}
		});

		server.once("listening", () => {
			server.close();
			resolve(true);
		});

		server.listen(port);
	});
};

/**
 * Function that starts the agents.
 *
 * @param {Object} options - Command options
 * @returns {Promise<void>} A promise that resolves when the agents are successfully started.
 */
const startAgents = async (options: {
	configure?: boolean;
	port?: number;
	character?: string;
}) => {
	// Set up standard paths and load .env
	const homeDir = os.homedir();
	const elizaDir = path.join(homeDir, ".eliza");
	const elizaDbDir = path.join(elizaDir, "db");
	const envFilePath = path.join(elizaDir, ".env");

	// Create .eliza directory if it doesn't exist
	if (!fs.existsSync(elizaDir)) {
		fs.mkdirSync(elizaDir, { recursive: true });
		logger.info(`Created directory: ${elizaDir}`);
	}

	// Create db directory if it doesn't exist
	if (!fs.existsSync(elizaDbDir)) {
		fs.mkdirSync(elizaDbDir, { recursive: true });
		logger.info(`Created database directory: ${elizaDbDir}`);
	}

	// Set the database directory in environment variables
	process.env.PGLITE_DATA_DIR = elizaDbDir;
	logger.info(`Using database directory: ${elizaDbDir}`);

	// Load environment variables from .eliza/.env if it exists
	if (fs.existsSync(envFilePath)) {
		dotenv.config({ path: envFilePath });
	}

	// Load existing configuration
	const existingConfig = loadConfig();

	// Check if we should reconfigure based on command-line option or if using default config
	const shouldConfigure = options.configure || existingConfig.isDefault;

	// Handle service and model selection
	if (shouldConfigure) {
		// Display current configuration
		displayConfigStatus();

		// First-time setup or reconfiguration requested
		if (existingConfig.isDefault) {
			logger.info("First time setup. Let's configure your Eliza agent.");
		} else {
			logger.info("Reconfiguration requested.");
		}
		// Save the configuration AFTER user has made selections
		saveConfig({
			lastUpdated: new Date().toISOString(),
		});
	}
	// Look for PostgreSQL URL in environment variables
	const postgresUrl = process.env.POSTGRES_URL;

	// Create server instance
	const server = new AgentServer({
		dataDir: elizaDbDir,
		postgresUrl,
	});

	// Set up server properties
	server.startAgent = async (character) => {
		logger.info(`Starting agent for character ${character.name}`);
		return startAgent(character, server);
	};
	server.stopAgent = (runtime: IAgentRuntime) => {
		stopAgent(runtime, server);
	};
	server.loadCharacterTryPath = loadCharacterTryPath;
	server.jsonToCharacter = jsonToCharacter;

	let serverPort =
		options.port || Number.parseInt(settings.SERVER_PORT || "3000");

	// Try to find a project or plugin in the current directory
	let isProject = false;
	let isPlugin = false;
	let pluginModule: Plugin | null = null;
	let projectModule: any = null;

	const currentDir = process.cwd();
	try {
		// Check if we're in a project with a package.json
		const packageJsonPath = path.join(process.cwd(), "package.json");
		logger.debug(`Checking for package.json at: ${packageJsonPath}`);
		
		if (fs.existsSync(packageJsonPath)) {
			// Read and parse package.json to check if it's a project or plugin
			const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
			logger.debug(`Found package.json with name: ${packageJson.name || 'unnamed'}`);

			// Check if this is a plugin (package.json contains 'eliza' section with type='plugin')
			if (packageJson.eliza?.type && packageJson.eliza.type === "plugin") {
				isPlugin = true;
				logger.info("Found Eliza plugin in current directory");
			}

			// Check if this is a project (package.json contains 'eliza' section with type='project')
			if (packageJson.eliza?.type && packageJson.eliza.type === "project") {
				isProject = true;
				logger.info("Found Eliza project in current directory");
			}

			// Also check for project indicators like a Project type export
			// or if the description mentions "project"
			if (!isProject && !isPlugin) {
				if (packageJson.description?.toLowerCase().includes("project")) {
					isProject = true;
					logger.info("Found project by description in package.json");
				}
			}

			// If we found a main entry in package.json, try to load it
			const mainEntry = packageJson.main;
			if (mainEntry) {
				const mainPath = path.resolve(process.cwd(), mainEntry);

				if (fs.existsSync(mainPath)) {
					try {
						// Try to import the module
						const importedModule = await import(mainPath);

						// First check if it's a plugin
						if (
							isPlugin ||
							(importedModule.default &&
								typeof importedModule.default === "object" &&
								importedModule.default.name &&
								typeof importedModule.default.init === "function")
						) {
							isPlugin = true;
							pluginModule = importedModule.default;
							logger.info(`Loaded plugin: ${pluginModule?.name || "unnamed"}`);

							if (!pluginModule) {
								logger.warn(
									"Plugin loaded but no default export found, looking for other exports",
								);

								// Try to find any exported plugin object
								for (const key in importedModule) {
									if (
										importedModule[key] &&
										typeof importedModule[key] === "object" &&
										importedModule[key].name &&
										typeof importedModule[key].init === "function"
									) {
										pluginModule = importedModule[key];
										logger.info(`Found plugin export under key: ${key}`);
										break;
									}
								}
							}
						}
						// Then check if it's a project
						else if (
							isProject ||
							(importedModule.default &&
								typeof importedModule.default === "object" &&
								importedModule.default.agents)
						) {
							isProject = true;
							projectModule = importedModule;
							logger.info(
								`Loaded project with ${projectModule.default?.agents?.length || 0} agents`,
							);
						}
					} catch (importError) {
						logger.error(`Error importing module: ${importError}`);
					}
				} else {
					logger.error(`Main entry point ${mainPath} does not exist`);
				}
			}
		}
	} catch (error) {
		logger.error(`Error checking for project/plugin: ${error}`);
	}

	// Log what was found
	logger.debug(`Classification results - isProject: ${isProject}, isPlugin: ${isPlugin}`);
	
	if (isProject) {
		logger.info("Found project configuration");
		if (projectModule?.default) {
			const project = projectModule.default;
			const agents = Array.isArray(project.agents)
				? project.agents
				: project.agent
					? [project.agent]
					: [];
			logger.info(`Project contains ${agents.length} agent(s)`);

			// Log agent names
			if (agents.length > 0) {
				logger.info(
					`Agents: ${agents.map((a) => a.character?.name || "unnamed").join(", ")}`,
				);
			}
		} else {
			logger.warn("Project module doesn't contain a valid default export");
		}
	} else if (isPlugin) {
		logger.info(`Found plugin: ${pluginModule?.name || "unnamed"}`);
	} else {
		// Change the log message to be clearer about what we're doing
		logger.info("Running in standalone mode - using default Eliza character");
		logger.debug("Will load the default Eliza character from ../characters/eliza");
	}

	// Start agents based on project, plugin, or custom configuration
	if (isProject && projectModule?.default) {
		// Load all project agents, call their init and register their plugins
		const project = projectModule.default;

		// Handle both formats: project with agents array and project with single agent
		const agents = Array.isArray(project.agents)
			? project.agents
			: project.agent
				? [project.agent]
				: [];

		if (agents.length > 0) {
			logger.info(`Found ${agents.length} agents in project`);

			// Prompt for environment variables for all plugins in the project
			try {
				await promptForProjectPlugins(project);
			} catch (error) {
				logger.warn(
					`Failed to prompt for project environment variables: ${error}`,
				);
			}

			const startedAgents = [];
			for (const agent of agents) {
				try {
					logger.info(`Starting agent: ${agent.character.name}`);
					const runtime = await startAgent(
						agent.character,
						server,
						agent.init,
						agent.plugins || [],
					);
					startedAgents.push(runtime);
					// wait .5 seconds
					await new Promise((resolve) => setTimeout(resolve, 500));
				} catch (agentError) {
					logger.error(
						`Error starting agent ${agent.character.name}: ${agentError}`,
					);
				}
			}

			if (startedAgents.length === 0) {
				logger.warn(
					"Failed to start any agents from project, falling back to custom character",
				);
				await startAgent(defaultCharacter, server);
			} else {
				logger.info(
					`Successfully started ${startedAgents.length} agents from project`,
				);
			}
		} else {
			logger.warn(
				"Project found but no agents defined, falling back to custom character",
			);
			await startAgent(defaultCharacter, server);
		}
	} else if (isPlugin && pluginModule) {
		// Before starting with the plugin, prompt for any environment variables it needs
		if (pluginModule.name) {
			try {
				await promptForEnvVars(pluginModule.name);
			} catch (error) {
				logger.warn(
					`Failed to prompt for plugin environment variables: ${error}`,
				);
			}
		}

		// Load the default character with all its default plugins, then add the test plugin
		logger.info(
			`Starting default Eliza character with plugin: ${pluginModule.name || "unnamed plugin"}`,
		);

		// Import the default character with all its plugins
		const { character: defaultElizaCharacter } = await import("../characters/eliza");
		
		// Create an array of plugins, including the explicitly loaded one
		// We're using our test plugin plus all the plugins from the default character
		const pluginsToLoad = [pluginModule];
		
		logger.debug(`Using default character with plugins: ${defaultElizaCharacter.plugins.join(", ")}`);
		logger.info("Plugin test mode: Using default character's plugins plus the plugin being tested");

		// Start the agent with the default character and our test plugin
		// We're in plugin test mode, so we should skip auto-loading embedding models
		await startAgent(defaultElizaCharacter, server, undefined, pluginsToLoad, {
			isPluginTestMode: true
		});
		logger.info("Character started with plugin successfully");
	} else {
		// When not in a project or plugin, load the default character with all plugins
		const { character: defaultElizaCharacter } = await import("../characters/eliza");
		logger.info("Using default Eliza character with all plugins");
		await startAgent(defaultElizaCharacter, server);
	}

	// Rest of the function remains the same...
	while (!(await checkPortAvailable(serverPort))) {
		logger.warn(`Port ${serverPort} is in use, trying ${serverPort + 1}`);
		serverPort++;
	}

	server.start(serverPort);

	if (serverPort !== Number.parseInt(settings.SERVER_PORT || "3000")) {
		logger.log(`Server started on alternate port ${serverPort}`);
	}

	// Display link to the client UI
	// First try to find it in the CLI package dist/client directory
	let clientPath = path.join(__dirname, "../../client");

	// If not found, fall back to the old relative path for development
	if (!fs.existsSync(clientPath)) {
		clientPath = path.join(__dirname, "../../../..", "client/dist");
	}
};

// Create command that can be imported directly
export const start = new Command()
	.name("start")
	.description("Start the Eliza agent with configurable plugins and services")
	.option("-p, --port <port>", "Port to listen on", (val) =>
		Number.parseInt(val),
	)
	.option(
		"-c, --configure",
		"Reconfigure services and AI models (skips using saved configuration)",
	)
	.option(
		"--character <character>",
		"Path or URL to character file to use instead of default",
	)
	.option("--build", "Build the project before starting")
	.action(async (options) => {
		try {
			// Build the project first unless skip-build is specified
			if (options.build) {
				await buildProject(process.cwd());
			}
			
			// Collect server options
			const characterPath = options.character;

			if (characterPath) {
				logger.info(`Loading character from ${characterPath}`);
				try {
					const characterData = await loadCharacterTryPath(characterPath);
					await startAgents(options);
				} catch (error) {
					logger.error(`Failed to load character: ${error}`);
					process.exit(1);
				}
			} else {
				await startAgents(options);
			}
		} catch (error) {
			handleError(error);
		}
	});

// This is the function that registers the command with the CLI
export default function registerCommand(cli: Command) {
	return cli.addCommand(start);
}
