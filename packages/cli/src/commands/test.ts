import { Command } from "commander";
import {
	logger,
	type IAgentRuntime,
	type Character,
	type ProjectAgent,
	AgentRuntime,
	stringToUuid,
	settings
} from "@elizaos/core";
import { loadProject } from "../project.js";
import { TestRunner } from "../testRunner.js";
import { AgentServer } from "../server/index.js";
import * as net from "node:net";
import path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as dotenv from "dotenv";
import { jsonToCharacter, loadCharacterTryPath } from "../server/loader";
import { promptForEnvVars } from "../utils/env-prompt.js";
import { handleError } from "../utils/handle-error";

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
	init?: (runtime: IAgentRuntime) => void,
	plugins: any[] = [],
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

	// add to container
	server.registerAgent(runtime);

	// report to console
	logger.debug(`Started ${runtime.character.name} as ${runtime.agentId}`);

	return runtime;
}

/**
 * Function that runs the tests.
 */
const runAgentTests = async (options: {
	port?: number;
	plugin?: string;
	skipPlugins?: boolean;
	skipProjectTests?: boolean;
}) => {
	const runtimes: IAgentRuntime[] = [];
	const projectAgents: ProjectAgent[] = [];

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

	// Always ensure database configuration is set
	try {
		await promptForEnvVars("pglite");
	} catch (error) {
		logger.warn(`Error configuring database: ${error}`);
	}

	// Look for PostgreSQL URL in environment variables
	const postgresUrl = process.env.POSTGRES_URL;

	// Create server instance
	logger.info("Creating server instance...");
	const server = new AgentServer({
		dataDir: elizaDbDir,
		postgresUrl,
	});
	logger.info("Server instance created");

	// Set up server properties
	logger.info("Setting up server properties...");
	server.startAgent = async (character) => {
		logger.info(`Starting agent for character ${character.name}`);
		return startAgent(character, server);
	};
	server.loadCharacterTryPath = loadCharacterTryPath;
	server.jsonToCharacter = jsonToCharacter;
	logger.info("Server properties set up");

	let serverPort = options.port || Number.parseInt(settings.SERVER_PORT || "3000");

	// Try to find a project in the current directory
	logger.info("Loading project from current directory:", process.cwd());
	let project;
	try {
		project = await loadProject(process.cwd());
		logger.info("Project loaded successfully:", JSON.stringify(project, null, 2));
		if (!project || !project.agents || project.agents.length === 0) {
			throw new Error("No agents found in project configuration");
		}
		logger.info(`Found ${project.agents.length} agents in project configuration`);
	} catch (error) {
		logger.error("Error loading project:", error);
		if (error instanceof Error) {
			logger.error("Error details:", error.message);
			logger.error("Stack trace:", error.stack);
		}
		throw error;
	}

	logger.info("Checking port availability...");
	while (!(await checkPortAvailable(serverPort))) {
		logger.warn(`Port ${serverPort} is in use, trying ${serverPort + 1}`);
		serverPort++;
	}
	logger.info(`Using port ${serverPort}`);

	logger.info("Starting server...");
	try {
		await server.start(serverPort);
		logger.info("Server started successfully");
	} catch (error) {
		logger.error("Error starting server:", error);
		if (error instanceof Error) {
			logger.error("Error details:", error.message);
			logger.error("Stack trace:", error.stack);
		}
		throw error;
	}

	try {
		// Start each agent in sequence
		logger.info(`Found ${project.agents.length} agents in project`);
		
		for (const agent of project.agents) {
			try {
				logger.info(`Starting agent: ${agent.character.name}`);
				const runtime = await startAgent(
					agent.character,
					server,
					agent.init,
					agent.plugins || [],
				);
				runtimes.push(runtime);
				projectAgents.push(agent);
				// wait .5 seconds between agent starts
				await new Promise((resolve) => setTimeout(resolve, 500));
			} catch (agentError) {
				logger.error(
					`Error starting agent ${agent.character.name}: ${agentError}`,
				);
			}
		}

		if (runtimes.length === 0) {
			throw new Error("Failed to start any agents from project");
		}

		logger.info(`Successfully started ${runtimes.length} agents from project`);

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

// Create command that can be imported directly
export const test = new Command()
	.name("test")
	.description("Run tests for Eliza agent plugins")
	.option("-p, --port <port>", "Port to listen on", (val) =>
		Number.parseInt(val),
	)
	.option("-P, --plugin <name>", "Name of plugin to test")
	.option("--skip-plugins", "Skip plugin tests")
	.option("--skip-project-tests", "Skip project tests")
	.action(async (options) => {
		logger.info("Starting test command...");
		logger.info("Command options:", options);
		try {
			logger.info("Running agent tests...");
			await runAgentTests(options);
		} catch (error) {
			logger.error("Error running tests:", error);
			if (error instanceof Error) {
				logger.error("Error details:", error.message);
				logger.error("Stack trace:", error.stack);
			}
			handleError(error);
		}
	});

// This is the function that registers the command with the CLI
export default function registerCommand(cli: Command) {
	return cli.addCommand(test);
}