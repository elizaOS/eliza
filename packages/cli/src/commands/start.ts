import {
	AgentRuntime,
	logger,
	settings,
	stringToUuid,
	type Character,
	type IAgentRuntime,
	type IDatabaseAdapter,
	type Plugin,
} from "@elizaos/core";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import * as fs from "node:fs";
import net from "node:net";
import * as path from "node:path";
import { character as defaultCharacter } from "../characters/eliza";
import { AgentServer } from "../server/index.ts";
import { jsonToCharacter, loadCharacterTryPath } from "../server/loader.ts";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.join(process.cwd(), ".env");

// Convert this into a command
import { Command } from "commander";
import { fileURLToPath } from "node:url";

export const wait = (minTime = 1000, maxTime = 3000) => {
	const waitTime =
		Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
	return new Promise((resolve) => setTimeout(resolve, waitTime));
};

async function startAgent(
	character: Character,
	server: AgentServer,
	init?: (runtime: IAgentRuntime) => void,
	plugins: Plugin[] = [],
	options: {
		dataDir?: string;
		postgresUrl?: string;
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

	const db = createDatabaseAdapter(options, runtime.agentId);

	runtime.registerDatabaseAdapter(db);

	// Make sure character exists in database
	await runtime.getDatabaseAdapter().ensureAgentExists(character);

	// start services/plugins/process knowledge
	await runtime.initialize();

	// add to container
	server.registerAgent(runtime);

	// report to console
	logger.debug(`Started ${runtime.character.name} as ${runtime.agentId}`);

	return runtime;
}

async function stopAgent(runtime: IAgentRuntime, server: AgentServer) {
	await runtime.getDatabaseAdapter().close();
	server.unregisterAgent(runtime.agentId);
}

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

const startAgents = async () => {
	// Try to find .env file by recursively checking parent directories
	let currentPath = envPath;
	let depth = 0;
	const maxDepth = 10;

	let postgresUrl = null;

	while (depth < maxDepth && currentPath.includes(path.sep)) {
		if (fs.existsSync(currentPath)) {
			const env = fs.readFileSync(currentPath, "utf8");
			const envVars = env.split("\n").filter((line) => line.trim() !== "");
			const postgresUrlLine = envVars.find((line) =>
				line.startsWith("POSTGRES_URL="),
			);
			if (postgresUrlLine) {
				postgresUrl = postgresUrlLine.split("=")[1].trim();
				break;
			}
		}

		// Move up one directory by getting the parent directory path
		// First get the directory containing the current .env file
		const currentDir = path.dirname(currentPath);
		// Then move up one directory from there
		const parentDir = path.dirname(currentDir);
		currentPath = path.join(parentDir, ".env");
		depth++;
	}

	// Implement the database directory setup logic
	let dataDir = "./elizadb"; // Default fallback path
	try {
		// 1. Get the user's home directory
		const homeDir = os.homedir();
		const elizaDir = path.join(homeDir, ".eliza");
		const elizaDbDir = path.join(elizaDir, "db");

		// Debug information
		console.log(`Setting up database directory at: ${elizaDbDir}`);

		// 2 & 3. Check if .eliza directory exists, create if not
		if (!fs.existsSync(elizaDir)) {
			console.log(`Creating .eliza directory at: ${elizaDir}`);
			fs.mkdirSync(elizaDir, { recursive: true });
		}

		// 4 & 5. Check if db directory exists in .eliza, create if not
		if (!fs.existsSync(elizaDbDir)) {
			console.log(`Creating db directory at: ${elizaDbDir}`);
			fs.mkdirSync(elizaDbDir, { recursive: true });
		}

		// 6, 7 & 8. Use the db directory
		dataDir = elizaDbDir;
		console.log(`Using database directory: ${dataDir}`);
	} catch (error) {
		console.warn(
			"Failed to create database directory in home directory, using fallback location:",
			error,
		);
		// 9. On failure, use the fallback path
	}

	const options = {
		dataDir: dataDir,
		postgresUrl,
	};

	const server = new AgentServer(options);

	// Assign the required functions first
	server.startAgent = async (character) => {
		logger.info(`Starting agent for character ${character.name}`);
		return startAgent(character, server);
	};
	server.stopAgent = (runtime: IAgentRuntime) => {
		stopAgent(runtime, server);
	};
	server.loadCharacterTryPath = loadCharacterTryPath;
	server.jsonToCharacter = jsonToCharacter;

	let serverPort = Number.parseInt(settings.SERVER_PORT || "3000");

	// 1. Check if we're in a project with a package.json
	const packageJsonPath = path.join(process.cwd(), "package.json");
	let isProject = false;
	let isPlugin = false;
	let pluginModule: Plugin | null = null;
	let projectPath = "";
	let projectModule: { default?: { agents: any[] } } | null = null;
	let useDefaultCharacter = false;

	try {
		if (fs.existsSync(packageJsonPath)) {
			// Read and parse package.json to check if it's a project or plugin
			const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

			const mainEntry = packageJson.main;
			// Check if this is a plugin
			isPlugin = false; // Reset to be sure
			const name = packageJson.name || "";
			const description = packageJson.description || "";

			// First check for exact match with plugin-starter
			if (
				(name.includes("plugin") || name.includes("adapter")) &&
				packageJson.main &&
				packageJson.dependencies &&
				packageJson.dependencies["@elizaos/core"]
			) {
				isPlugin = true;
				logger.info(`Found plugin package: ${name}`);
			}
			// Last resort check description
			else if (
				description.toLowerCase().includes("plugin") &&
				packageJson.main &&
				packageJson.dependencies &&
				packageJson.dependencies["@elizaos/core"]
			) {
				isPlugin = true;
				logger.info(`Found plugin from description: ${description}`);
			}

			if (mainEntry && !isPlugin) {
				isProject = true;
				logger.info("Package is not detected as a plugin, treating as project");
			} else if (isPlugin) {
				logger.info("Plugin detected - will load onto default character");
			} else {
				logger.info(
					"No main entry point found for project, loading default character",
				);
				useDefaultCharacter = true;
			}

			// 2. Read and parse package.json to get main entry point and check for build script
			const hasBuildScript = packageJson.scripts?.build;

			// Check if dist directory exists
			const distDir = path.join(process.cwd(), "dist");
			const distExists = fs.existsSync(distDir);

			// If no build script or no dist directory exists
			if (mainEntry && !hasBuildScript && !distExists) {
				if (isPlugin) {
					logger.info(
						"No build script and no dist directory found for plugin, building...",
					);
					try {
						// Execute build command - use bun directly for plugins
						const { exec } = require("node:child_process");
						await new Promise<void>((resolve, _reject) => {
							// Use bun build for plugins directly
							exec("bun run build", (error: Error | null) => {
								if (error) {
									logger.error(
										`Error building plugin with bun: ${error.message}`,
									);
									resolve();
									return;
								}
								logger.info("Plugin built successfully with bun");
								resolve();
							});
						});

						// After building, check if dist now exists
						if (!fs.existsSync(distDir)) {
							logger.warn(
								"Dist directory still not found after build for plugin",
							);
							// Don't change isPlugin to false here, just try to load from src directly
						}
					} catch (buildError) {
						logger.error(`Failed to build plugin: ${buildError}`);
						// Don't change isPlugin to false here, just try to load from src directly
					}
				} else {
					logger.info(
						"No build script and no dist directory found, using default character",
					);
					useDefaultCharacter = true;
				}
			}
			// If there's a build script but no dist, run the build
			else if (mainEntry && hasBuildScript && !distExists) {
				if (isPlugin) {
					logger.info(
						"Build script found but no dist directory for plugin, running bun build...",
					);
					try {
						// Execute build command - use bun directly for plugins
						const { exec } = require("node:child_process");
						await new Promise<void>((resolve, _reject) => {
							// Use bun build for plugins directly
							exec("bun run build", (error: Error | null) => {
								if (error) {
									logger.error(
										`Error building plugin with bun: ${error.message}`,
									);
									resolve();
									return;
								}
								logger.info("Plugin built successfully with bun");
								resolve();
							});
						});

						// After building, check if dist now exists
						if (!fs.existsSync(distDir)) {
							logger.warn(
								"Dist directory still not found after build for plugin",
							);
							// Don't change isPlugin to false here, just try to load from src directly
						}
					} catch (buildError) {
						logger.error(`Failed to build plugin: ${buildError}`);
						// Don't change isPlugin to false here, just try to load from src directly
					}
				} else if (packageJson.main) {
					logger.info(
						"Build script found but no dist directory, running build...",
					);
					try {
						// Execute build command
						const { exec } = require("node:child_process");
						await new Promise<void>((resolve, _reject) => {
							exec("npm run build", (error: Error | null) => {
								if (error) {
									logger.error(`Error building project: ${error.message}`);
									useDefaultCharacter = true;
									resolve();
									return;
								}
								logger.info("Project built successfully");
								resolve();
							});
						});

						// After building, check if dist now exists
						if (!fs.existsSync(distDir)) {
							logger.warn(
								"Dist directory still not found after build, using default character",
							);
							useDefaultCharacter = true;
						}
					} catch (buildError) {
						logger.error(`Failed to build project: ${buildError}`);
						useDefaultCharacter = true;
					}
				}
			}

			// If we're not using the default character, try to import the project or plugin
			if (!useDefaultCharacter || isPlugin) {
				// Load the compiled project or plugin from package.json's 'main' path entry
				if (mainEntry) {
					projectPath = path.resolve(process.cwd(), mainEntry);

					if (fs.existsSync(projectPath)) {
						if (isPlugin) {
							logger.info(`Loading plugin from ${projectPath}`);
							try {
								const pluginImport = await import(projectPath);
								pluginModule = pluginImport.default;

								if (!pluginModule) {
									logger.error(
										"Plugin module does not export a default export",
									);
									// Try to find any exported plugin object
									for (const key in pluginImport) {
										if (
											pluginImport[key] &&
											typeof pluginImport[key] === "object" &&
											pluginImport[key].name &&
											typeof pluginImport[key].init === "function"
										) {
											pluginModule = pluginImport[key];
											logger.info(`Found plugin export under key: ${key}`);
											break;
										}
									}

									if (!pluginModule) {
										logger.error("Could not find any valid plugin export");
										isPlugin = false;
										useDefaultCharacter = true;
									}
								} else {
									logger.info(
										`Successfully loaded plugin: ${
											pluginModule.name || "unnamed plugin"
										}`,
									);
								}
							} catch (importError) {
								logger.error(`Error importing plugin module: ${importError}`);
								isPlugin = false;
								useDefaultCharacter = true;
							}
						} else {
							logger.info(`Loading project from ${projectPath}`);
							try {
								projectModule = await import(projectPath);
							} catch (importError) {
								logger.error(`Error importing project module: ${importError}`);
								useDefaultCharacter = true;
							}
						}
					} else {
						if (isPlugin) {
							logger.error(`Plugin entry point ${projectPath} does not exist`);
							// Try to find the plugin in src directory
							const srcPath = path.join(process.cwd(), "src", "index.ts");
							if (fs.existsSync(srcPath)) {
								logger.info(`Trying to load plugin from src: ${srcPath}`);
								try {
									// For TypeScript files, we need to transpile or use ts-node/esm
									const { exec } = require("node:child_process");
									exec("npx tsc", async (error: Error | null) => {
										if (!error) {
											try {
												const srcModule = await import(
													path.join(process.cwd(), "dist", "index.js")
												);
												pluginModule = srcModule.default;
												logger.info(
													"Successfully loaded plugin from transpiled source",
												);
											} catch (e) {
												logger.error(`Failed to load transpiled plugin: ${e}`);
											}
										}
									});
								} catch (e) {
									logger.error(`Failed to transpile plugin: ${e}`);
								}
							} else {
								isPlugin = false;
								useDefaultCharacter = true;
							}
						} else {
							logger.error(`Main entry point ${projectPath} does not exist`);
							useDefaultCharacter = true;
						}
					}
				} else {
					logger.error('No "main" field found in package.json');
					useDefaultCharacter = true;
				}
			}
		} else {
			logger.info("No package.json found, using default character");
			useDefaultCharacter = true;
		}
	} catch (error) {
		logger.error(`Error checking for project: ${error}`);
		useDefaultCharacter = true;
	}

	// Start agents based on project, plugin, or default configuration
	if (isPlugin && pluginModule) {
		// Load the default character and add the plugin to it
		logger.info(
			`Starting default character with plugin: ${
				pluginModule.name || "unnamed plugin"
			}`,
		);
		await startAgent(defaultCharacter, server, undefined, [pluginModule]);
		logger.info("Default character started with plugin successfully");
	} else if (isProject) {
		// Load all project agents, call their init and register their plugins
		const project = projectModule.default as import("@elizaos/core").Project;
		logger.info(`Found ${project.agents.length} agents in project`);

		const startedAgents = [];
		for (const agent of project.agents ?? []) {
			try {
				logger.info(`Starting agent: ${agent.character.name}`);
				const runtime = await startAgent(
					agent.character,
					server,
					agent.init,
					agent.plugins || [],
				);
				startedAgents.push(runtime);
			} catch (agentError) {
				logger.error(
					`Error starting agent ${agent.character.name}: ${agentError}`,
				);
			}
		}

		if (startedAgents.length === 0) {
			logger.warn(
				"Failed to start any agents from project, falling back to default character",
			);
			await startAgent(defaultCharacter, server);
		} else {
			logger.info(
				`Successfully started ${startedAgents.length} agents from project`,
			);
		}
	} else {
		logger.info("No project or plugin found, starting default character");
		await startAgent(defaultCharacter, server);
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
	const clientPath = path.join(
		__dirname,
		"../../../..",
		"packages/client/dist",
	);
	if (fs.existsSync(clientPath)) {
		logger.success(
			`Client UI is available at http://localhost:${serverPort}/client`,
		);
	} else {
		const clientSrcPath = path.join(
			__dirname,
			"../../../..",
			"packages/client",
		);
		if (fs.existsSync(clientSrcPath)) {
			logger.info(
				"Client build not found. You can build it with: cd packages/client && npm run build",
			);
		}
	}
};

// Convert this into a command
export const start = new Command("start")
	.description("Start the ElizaOS server with project agents")
	.action(async () => {
		startAgents().catch((error) => {
			logger.error("Unhandled error in startAgents:", error.message);
			process.exit(1);
		});

		// Prevent unhandled exceptions from crashing the process if desired
		// Handle uncaught exceptions to prevent the process from crashing
		process.on("uncaughtException", (err) => {
			console.error("uncaughtException", err);
		});

		// Handle unhandled rejections to prevent the process from crashing
		process.on("unhandledRejection", (err) => {
			console.error("unhandledRejection", err);
		});
	});

export default start;
