#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { agent } from "@/src/commands/agent";
import { init } from "@/src/commands/init";
import { plugins } from "@/src/commands/plugins";
import { start } from "@/src/commands/start";
import { teeCommand as tee } from "@/src/commands/tee";
import { loadEnvironment } from "@/src/utils/get-config";
import { logger } from "@elizaos/core";
import { Command } from "commander";

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

/**
 * Asynchronous function that serves as the main entry point for the application.
 * It loads environment variables, initializes the CLI program, and parses the command line arguments.
 * @returns {Promise<void>}
 */
async function main() {
	// Load environment variables, trying project .env first, then global ~/.eliza/.env
	await loadEnvironment();

	// For ESM modules we need to use import.meta.url instead of __dirname
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);

	// Find package.json relative to the current file
	const packageJsonPath = path.resolve(__dirname, "../package.json");
	console.log("packageJsonPath", packageJsonPath);

	// Add a simple check in case the path is incorrect
	let version = "0.0.0"; // Fallback version
	if (!fs.existsSync(packageJsonPath)) {
		console.warn(
			"Package.json not found at expected location:",
			packageJsonPath,
		);
		console.warn("Using fallback version:", version);
	} else {
		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
		console.log("packageJson", packageJson);
		version = packageJson.version;
	}

	console.log("version", version);

	const program = new Command()
		.name("eliza")
		.description("elizaOS CLI - Manage your AI agents and plugins")
		.version(version);

	console.log("program", program);

	program
		.addCommand(init)
		.addCommand(plugins)
		.addCommand(agent)
		.addCommand(tee)
		.addCommand(start);
	program.parse(process.argv);
}

main().catch((error) => {
	logger.error("An error occurred:", error);
	process.exit(1);
});
