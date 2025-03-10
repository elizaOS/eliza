import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	AgentRuntime,
	type Character,
	type IAgentRuntime,
	ModelTypes,
	type Plugin,
	type TestCase,
	type TestSuite,
	type UUID,
	logger,
	stringToUuid
} from "@elizaos/core";
import chalk from "chalk";
import { Command } from "commander";
import * as dotenv from "dotenv";
import ora from "ora";
import { AgentServer } from "../server/index";
import { loadCharacterTryPath } from "../server/loader";
import { generateCustomCharacter } from "../utils/character-generator";
import {
	displayConfigStatus,
	getPluginStatus,
	loadConfig,
	saveConfig,
} from "../utils/config-manager";
import { promptForEnvVars } from "../utils/env-prompt";
import { handleError } from "../utils/handle-error";

// Define the COLORS constant for colorized output
const COLORS = {
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
	reset: "\x1b[0m",
	bold: "\x1b[1m",
};

/**
 * Interface for storing test statistics
 */
interface TestStats {
	total: number;
	passed: number;
	failed: number;
	skipped: number;
}

/**
 * Interface for storing test results
 */
interface TestResult {
	file: string;
	suite: string;
	name: string;
	status: "passed" | "failed";
	error?: Error;
}

/**
 * Enumeration for test status values
 */
enum TestStatus {
	Passed = "passed",
	Failed = "failed",
}

/**
 * Function to detect the current context (plugin or project) and set up appropriate testing options
 * Returns an object with contextual information
 */
async function detectContext(): Promise<{
	type: 'plugin' | 'project' | 'unknown';
	name: string | null;
	path: string;
	plugin: Plugin | null;
}> {
	const cwd = process.cwd();
	
	// Check if we're in a plugin directory
	try {
		if (fs.existsSync(path.join(cwd, 'package.json'))) {
			const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
			const name = packageJson.name || '';
			
			// Enhanced pattern matching to detect plugins with various naming patterns
			if (name.includes('plugin-') || name.includes('plugin_') || name.startsWith('@elizaos/plugin-')) {
				// Extract plugin name - handle various formats
				let pluginName;
				if (name.startsWith('@elizaos/plugin-')) {
					// For @elizaos/plugin-xxx format
					pluginName = name.substring('@elizaos/plugin-'.length);
				} else {
					// For plugin-xxx format
					const pluginNameMatch = name.match(/plugin[-_]([^/]+)$/);
					pluginName = pluginNameMatch?.[1] ? pluginNameMatch[1] : name;
				}
				
				logger.info(`Detected plugin directory with name: ${name}, plugin ID: ${pluginName}`);
				
				// Try to load the plugin
				logger.info(`Attempting to load plugin from current directory: ${pluginName}`);
				
				// Look for built files first
				const possiblePaths = [
					path.join(cwd, 'dist', 'index.js'),
					path.join(cwd, 'lib', 'index.js'),
					path.join(cwd, 'build', 'index.js'),
					path.join(cwd, 'index.js')
				];
				
				let plugin: Plugin | null = null;
				
				for (const importPath of possiblePaths) {
					if (fs.existsSync(importPath)) {
						try {
							const imported = await import(importPath);
							plugin = imported.default || imported;
							if (plugin && typeof plugin === 'object') {
								// Ensure the plugin has a name if it wasn't set
								if (!plugin.name) {
									plugin.name = pluginName;
								}
								logger.success(`Successfully loaded plugin: ${plugin.name}`);
								return {
									type: 'plugin',
									name: pluginName,
									path: cwd,
									plugin
								};
							}
						} catch (error) {
							logger.debug(`Error importing plugin from ${importPath}: ${error}`);
						}
					}
				}
				
				// If we couldn't load the plugin but we're in a plugin directory
				return {
					type: 'plugin',
					name: pluginName,
					path: cwd,
					plugin: null
				};
			}
		}
		
		// Check if we're in a project directory
		const projectIndicators = [
			path.join(cwd, 'eliza.config.js'),
			path.join(cwd, 'eliza.config.json'),
			path.join(cwd, '.elizarc'),
			path.join(cwd, 'characters')
		];
		
		for (const indicator of projectIndicators) {
			if (fs.existsSync(indicator)) {
				return {
					type: 'project',
					name: path.basename(cwd),
					path: cwd,
					plugin: null
				};
			}
		}
		
	} catch (error) {
		logger.debug(`Error detecting context: ${error}`);
	}
	
	// Default - unknown context
	return {
		type: 'unknown',
		name: null,
		path: cwd,
		plugin: null
	};
}

/**
 * Find plugins within a project directory
 */
async function findProjectPlugins(projectPath: string): Promise<Plugin[]> {
	const plugins: Plugin[] = [];
	
	try {
		// Look for potential plugin directories
		const dirs = fs.readdirSync(projectPath);
		
		for (const dir of dirs) {
			const fullPath = path.join(projectPath, dir);
			
			// Skip non-directories and node_modules
			if (!fs.statSync(fullPath).isDirectory() || dir === 'node_modules') {
				continue;
			}
			
			// Check if this directory contains a plugin
			const possibleEntryPoints = [
				path.join(fullPath, 'dist', 'index.js'),
				path.join(fullPath, 'lib', 'index.js'),
				path.join(fullPath, 'build', 'index.js'),
				path.join(fullPath, 'src', 'index.ts'),
				path.join(fullPath, 'src', 'index.js'),
				path.join(fullPath, 'index.js'),
				path.join(fullPath, 'index.ts')
			];
			
			for (const entryPoint of possibleEntryPoints) {
				if (fs.existsSync(entryPoint)) {
					try {
						const imported = await import(entryPoint);
						const plugin = imported.default || imported;
						
						if (plugin && typeof plugin === 'object') {
							logger.info(`Found plugin in project: ${plugin.name || 'unnamed'}`);
							plugins.push(plugin);
							break; // Found a plugin for this directory, move to next one
						}
					} catch (error) {
						logger.debug(`Error importing plugin from ${entryPoint}: ${error}`);
					}
				}
			}
		}
	} catch (error) {
		logger.error(`Error finding project plugins: ${error}`);
	}
	
	return plugins;
}

/**
 * Class for running plugin tests
 */
class TestRunner {
	private runtime: IAgentRuntime;
	private stats: TestStats;
	private testResults: Map<string, TestResult[]> = new Map();
	
	constructor(runtime: IAgentRuntime) {
		this.runtime = runtime;
		this.stats = {
			total: 0,
			passed: 0,
			failed: 0,
			skipped: 0,
		};
	}

	private async runTestCase(
		test: TestCase,
		file: string,
		suite: string,
	): Promise<void> {
		logger.info(`  Running test: ${test.name}`);
		this.stats.total++;

		try {
			await test.fn(this.runtime);
			logger.success(`  ✅ Test passed: ${test.name}`);
			this.addTestResult(file, suite, test.name, TestStatus.Passed);
			this.stats.passed++;
		} catch (error) {
			logger.error(`  ❌ Test failed: ${test.name}`);
			if (error instanceof Error) {
				logger.error(`     ${error.message}`);
			} else {
				logger.error(`     ${error}`);
			}
			this.addTestResult(file, suite, test.name, TestStatus.Failed, error as Error);
			this.stats.failed++;
		}
	}

	private addTestResult(
		file: string,
		suite: string,
		name: string,
		status: TestStatus,
		error?: Error,
	) {
		if (!this.testResults.has(file)) {
			this.testResults.set(file, []);
		}

		this.testResults.get(file)!.push({
			file,
			suite,
			name,
			status,
			error,
		});
	}

	private async runTestSuite(suite: TestSuite, file: string): Promise<void> {
		logger.info(`Suite: ${suite.name}`);
		for (const test of suite.tests) {
			await this.runTestCase(test, file, suite.name);
		}
	}

	public async runPluginTests(): Promise<TestStats> {
		console.log("\n🧪 Running plugin tests...");
		
		// Get the plugins from the runtime
		const plugins = this.runtime.plugins;
		
		// No plugins found
		if (!plugins || plugins.length === 0) {
			logger.warn("No plugins found to test.");
			return this.stats;
		}

		logger.info(`Found ${plugins.length} plugins in the runtime`);

		for (const plugin of plugins) {
			try {
				const pluginName = plugin.name || "unnamed plugin";
				logger.info(`Running tests for plugin: ${pluginName}`);
				
				const pluginTests = plugin.tests;
				
				// Skip if the plugin has no tests
				if (!pluginTests) {
					logger.info(`No tests found for plugin: ${pluginName}`);
					this.stats.skipped++;
					continue;
				}
				
				// Handle both single suite and array of suites
				const testSuites = Array.isArray(pluginTests)
					? pluginTests
					: [pluginTests];

				for (const suite of testSuites) {
					if (suite) {
						const fileName = `${pluginName} test suite`;
						await this.runTestSuite(suite, fileName);
					}
				}
			} catch (error) {
				logger.error(`Error in plugin ${plugin.name || 'unnamed'}:`, error);
				this.stats.failed++;
			}
		}

		this.logTestSummary();
		return this.stats;
	}

	private logTestSummary(): void {
		console.log("\n--- Test Results Summary ---");
		
		const colorize = (
			text: string,
			color: keyof typeof COLORS,
			bold = false,
		): string => {
			const colorCode = COLORS[color];
			const boldCode = bold ? COLORS.bold : "";
			return `${boldCode}${colorCode}${text}${COLORS.reset}`;
		};

		const printSectionHeader = (title: string, color: keyof typeof COLORS) => {
			console.log(colorize(`\n${title}`, color, true));
			console.log(colorize("=".repeat(title.length), color, true));
		};

		if (this.stats.failed > 0) {
			printSectionHeader("Failed Tests", "red");

			for (const [file, results] of this.testResults.entries()) {
				const failedResults = results.filter(
					(r) => r.status === TestStatus.Failed,
				);
				if (failedResults.length > 0) {
					console.log(`\n${colorize(file, "white", true)}`);
					for (const result of failedResults) {
						console.log(
							`  ${colorize("✖", "red")} ${result.suite} › ${result.name}`,
						);
						if (result.error) {
							console.log(`    ${colorize(result.error.message, "white")}`);
						}
					}
				}
			}
		}

		if (this.stats.passed > 0) {
			printSectionHeader("Passed Tests", "green");

			for (const [file, results] of this.testResults.entries()) {
				const passedResults = results.filter(
					(r) => r.status === TestStatus.Passed,
				);
				if (passedResults.length > 0) {
					console.log(`\n${colorize(file, "white", true)}`);
					for (const result of passedResults) {
						console.log(
							`  ${colorize("✓", "green")} ${result.suite} › ${result.name}`,
						);
					}
				}
			}
		}

		if (this.stats.skipped > 0) {
			printSectionHeader("Skipped Tests", "yellow");
			console.log(
				`${colorize(`${this.stats.skipped} plugins had no tests defined`, "yellow")}`,
			);
		}

		console.log("\n--- Summary ---");
		console.log(
			`Total: ${this.stats.total}, ${colorize(`Passed: ${this.stats.passed}`, "green")}, ${colorize(`Failed: ${this.stats.failed}`, "red")}, ${colorize(`Skipped: ${this.stats.skipped}`, "yellow")}`,
		);
	}
}

const wait = (minTime = 1000, maxTime = 3000) => {
	return new Promise((resolve) => {
		setTimeout(resolve, Math.random() * (maxTime - minTime) + minTime);
	});
};

/**
 * Checks if a specific port is available.
 */
const checkPortAvailable = (port: number): Promise<boolean> => {
	return new Promise((resolve) => {
		const tester = net.createServer()
			.once("error", () => {
				resolve(false);
			})
			.once("listening", () => {
				tester.close();
				resolve(true);
			})
			.listen(port);
	});
};

/**
 * Starts the agent by initializing the runtime.
 */
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

	// start services/plugins/process knowledge
	await runtime.initialize();

	// add to container
	server.registerAgent(runtime);

	// report to console
	logger.debug(`Started ${runtime.character.name} as ${runtime.agentId}`);

	return runtime;
}

/**
 * Stops the agent by cleaning up the runtime.
 */
async function stopAgent(runtime: IAgentRuntime, server: AgentServer) {
	await runtime.close();
	server.unregisterAgent(runtime.agentId);
}

/**
 * Main function to run tests for the agents
 */
const runAgentTests = async (options: {
	configure?: boolean;
	port?: number;
	character?: string;
	plugin?: string;
}) => {
	// Auto-detect context to determine what we're testing
	const context = await detectContext();
	
	// Early validation of our context
	if (context.type === 'plugin') {
		logger.info(`Detected we're in plugin directory: ${context.name}`);
		if (!context.plugin) {
			logger.error(`Failed to load plugin from ${context.path}. Make sure the plugin is built.`);
			return;
		}
	} else if (context.type === 'project') {
		logger.info(`Detected we're in project directory: ${context.name}`);
	} else {
		logger.warn('No plugin or project detected in the current directory.');
		logger.warn('To run tests, you need to be in a plugin or project directory.');
		return;
	}
	
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

	// Load existing configuration
	const existingConfig = loadConfig();
	const pluginStatus = getPluginStatus();

	// For minimal test setup we don't need many services
	// This helps with cleaner test isolation
	let aiModels: string[] = [];
	
	// Only load OpenAI if we're in a project or if the plugin needs it
	if (context.type === 'project' || (context.type === 'plugin' && !context.plugin.models)) {
		aiModels = ["openai"];
		logger.info("Loading OpenAI for testing");
	}

	// Generate a clean config for testing
	const settings = {
		services: [],
		aiModels: aiModels,
		lastUpdated: new Date().toISOString()
	};
	saveConfig(settings);

	// Initialize plugins from existing config
	const config = loadConfig();
	
	// Set up core variables for the agent
	let character = generateCustomCharacter([], config.aiModels || []);
	
	// Try to load a custom character if specified
	if (options.character) {
		try {
			const customCharacterPath = options.character;
			character = await loadCharacterTryPath(customCharacterPath);
			logger.info(`Loaded custom character: ${character.name}`);
		} catch (error) {
			logger.error(`Failed to load custom character: ${error}`);
			logger.info("Falling back to default character");
		}
	}

	// Set up the agent server
	const serverPort = options.port || Number.parseInt(process.env.PORT || "3000");
	const server = new AgentServer({
		dataDir: elizaDbDir,
	});
	let runtime: IAgentRuntime | null = null;

	// Handle plugin initialization for external services if needed
	if (aiModels.length > 0) {
		for (const pluginName of aiModels) {
			try {
				await promptForEnvVars(pluginName);
			} catch (error) {
				logger.warn(
					`Failed to prompt for plugin environment variables: ${error}`,
				);
			}
		}
	}

	// Create an array of plugins to use
	const pluginsToUse: Plugin[] = [];
	
	// If we're in a plugin directory, add the local plugin to the runtime
	if (context.type === 'plugin' && context.plugin) {
		pluginsToUse.push(context.plugin);
		logger.info(`Added local plugin ${context.plugin.name} to runtime`);
	}
	// If we're in a project directory, find project plugins
	else if (context.type === 'project') {
		const projectPlugins = await findProjectPlugins(context.path);
		if (projectPlugins.length > 0) {
			pluginsToUse.push(...projectPlugins);
			logger.info(`Added ${projectPlugins.length} project plugins to runtime`);
		} else {
			logger.warn("No plugins found in project. Tests may not run properly.");
		}
	}

	// Start the server
	let currentPort = serverPort;
	while (!(await checkPortAvailable(currentPort))) {
		logger.warn(`Port ${currentPort} is in use, trying ${currentPort + 1}`);
		currentPort++;
	}

	server.start(currentPort);

	// Display startup message
	logger.success(`Test server started on port ${currentPort}`);

	try {
		const spinner = ora("Starting agent...").start();
		
		// Start the agent runtime with the appropriate plugins
		runtime = await startAgent(
			character,
			server,
			async (runtime) => {
				// No additional runtime initialization needed
			},
			pluginsToUse,
			{
				dataDir: elizaDbDir,
				postgresUrl: process.env.PGLITE_URL,
			},
		);

		spinner.succeed("Agent started successfully!");

		// Run tests for the loaded plugins
		logger.info("Running tests for loaded plugins");
		const testRunner = new TestRunner(runtime);
		const stats = await testRunner.runPluginTests();
		
		if (stats.total === 0) {
			logger.warn("No tests found in the loaded plugins. Make sure your plugins have 'tests' defined.");
		}

		// Clean up
		await stopAgent(runtime, server);
		logger.info("Test server stopped");
		process.exit(0);
	} catch (error) {
		logger.error("Error running tests:", error);
		process.exit(1);
	}
};

// Create command that can be imported directly
export const test = new Command()
	.name("test")
	.description("Run tests for the Eliza agent plugins")
	.option(
		"-c, --configure",
		"Reconfigure the agent (select plugins & services)",
		false,
	)
	.option("-p, --port <port>", "Port to run the server on", (val) =>
		Number.parseInt(val, 10),
	)
	.option(
		"--character <path>",
		"Path to a custom character file (JSON or JS/TS module)",
	)
	.option(
		"--plugin <name>",
		"Run tests for a specific plugin only (e.g., 'local-ai', 'openai')"
	)
	.action((options) => {
		runAgentTests(options).catch((error) => {
			logger.error("Failed to run tests:", error);
			process.exit(1);
		});
	});

export default function registerCommand(cli: Command) {
	return cli.addCommand(test);
} 