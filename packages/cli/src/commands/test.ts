import { Command } from "commander";
import {
	logger,
	type IAgentRuntime,
	type Character,
	type ProjectAgent,
	type Plugin,
	AgentRuntime,
	stringToUuid
} from "@elizaos/core";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import { loadProject } from "../project.js";
import { TestRunner } from "../testRunner.js";
import { AgentServer, type ServerOptions } from "../server/index.js";
import * as net from "node:net";
import ora from "ora";
import path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as dotenv from "dotenv";

// Helper function to check port availability
async function checkPortAvailable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => {
			resolve(false);
		});
		server.once("listening", () => {
			server.close();
			resolve(true);
		});
		server.listen(port);
	});
}

// Helper function to start an agent
async function startAgent(
	character: Character,
	server: AgentServer,
	plugins: Plugin[] = [],
	options: {
		dataDir?: string;
		postgresUrl?: string;
	} = {},
): Promise<IAgentRuntime> {
	try {
		character.id ??= stringToUuid(character.name);

		// Create a database adapter for testing
		const adapter = createDatabaseAdapter(
			{
				dataDir: options.dataDir || path.join(os.tmpdir(), `eliza-test-${Date.now()}`),
				postgresUrl: options.postgresUrl,
			},
			character.id
		);

		// Initialize the database adapter
		try {
			logger.info("Initializing database adapter...");
			await adapter.init();
			logger.success("Database adapter initialized successfully");
		} catch (error) {
			logger.error("Failed to initialize database adapter:", error);
			throw error;
		}

		const runtime = new AgentRuntime({
			character,
			plugins,
			ignoreBootstrap: true, // Skip bootstrap plugin for tests
			adapter // Provide the database adapter
		});

		// Initialize runtime
		logger.info(`Initializing runtime for ${character.name}`);
		await runtime.initialize();

		// Register with server
		server.registerAgent(runtime);

		// Report success
		logger.success(`Started agent ${runtime.character.name} (${runtime.agentId})`);

		return runtime;
	} catch (error) {
		logger.error(`Failed to start agent ${character.name}:`, error);
		throw error;
	}
}

const runAgentTests = async (options: {
	configure?: boolean;
	port?: number;
	character?: string;
	plugin?: string;
	skipPlugins?: boolean;
	skipProjectTests?: boolean;
}) => {
	let runtimes: IAgentRuntime[] = [];
	let projectAgents: ProjectAgent[] = [];

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

	// Load environment variables from .eliza/.env if it exists
	if (fs.existsSync(envFilePath)) {
		dotenv.config({ path: envFilePath });
		logger.info(`Loaded .env file from: ${envFilePath}`);
	}

	const serverOptions: ServerOptions = {
		dataDir: elizaDbDir,
		middlewares: [],
		postgresUrl: process.env.POSTGRES_URL
	};

	const server = new AgentServer(serverOptions);

	// Initialize database
	try {
		await server.database.init();
		logger.success("Database initialized successfully");
	} catch (error) {
		logger.error("Failed to initialize database:", error);
		if (error instanceof Error) {
			logger.error("Error details:", error.message);
		}
		process.exit(1);
	}

	// Set up server properties
	server.startAgent = async (character) => {
		logger.info(`Starting agent for character ${character.name}`);
		return startAgent(character, server, [], { 
			dataDir: elizaDbDir,
			postgresUrl: process.env.POSTGRES_URL 
		});
	};

	const serverPort = Number.parseInt(options.port?.toString() || "3000", 10);

	// Start the server
	let currentPort = serverPort;
	while (!(await checkPortAvailable(currentPort))) {
		logger.warn(`Port ${currentPort} is in use, trying ${currentPort + 1}`);
		currentPort++;
	}

	await server.start(currentPort);
	logger.success(`Test server started on port ${currentPort}`);

	try {
		const spinner = ora("Starting agent...").start();
		
		// Start the agent runtime(s)
		if (options.character) {
			const character = await server.loadCharacterTryPath(options.character);
			const runtime = await server.startAgent(character);
			runtimes = [runtime];
		} else {
			try {
				// Try to load project from current directory
				const project = await loadProject(".");
				if (project?.agents.length > 0) {
					logger.info(`Loading ${project.agents.length} project agents`);
					for (const agent of project.agents) {
						logger.info(`Starting agent: ${agent.character.name}`);
						const runtime = await server.startAgent(agent.character);
						runtimes.push(runtime);
					}
					projectAgents = project.agents;
					logger.success(`Successfully loaded ${project.agents.length} project agents`);
				} else {
					throw new Error("No project agents found in current directory");
				}
			} catch (error) {
				logger.error("Failed to load project:", error);
				if (error instanceof Error) {
					logger.error("Error details:", error.message);
					logger.error("Stack trace:", error.stack);
				}
				process.exit(1);
			}
		}

		spinner.succeed("Agent(s) started");

		// Run tests for each agent
		let totalFailed = 0;
		for (let i = 0; i < runtimes.length; i++) {
			const runtime = runtimes[i];
			const projectAgent = projectAgents[i];
			
			logger.info(`Running tests for agent: ${runtime.character.name}`);
			const testRunner = new TestRunner(runtime, projectAgent);
			const results = await testRunner.runTests({
				filter: options.plugin,
				skipPlugins: options.skipPlugins,
				skipProjectTests: options.skipProjectTests
			});
			totalFailed += results.failed;
		}

		// Clean up
		await server.stop();
		process.exit(totalFailed > 0 ? 1 : 0);
	} catch (error) {
		logger.error("Error running tests:", error);
		if (error instanceof Error) {
			logger.error("Error details:", error.message);
			logger.error("Stack trace:", error.stack);
		}
		await server.stop();
		process.exit(1);
	}
};

const test = new Command("test")
	.description("Run tests for Eliza agent plugins")
	.option("-c, --configure", "Configure test settings")
	.option("-p, --port <number>", "Port to run test server on", "3000")
	.option("-C, --character <path>", "Path to character file")
	.option("-P, --plugin <name>", "Name of plugin to test")
	.option("--skip-plugins", "Skip plugin tests")
	.option("--skip-project-tests", "Skip project tests")
	.action(async (options) => {
		await runAgentTests(options);
	});

export { test };
export default test;