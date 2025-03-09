import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import dotenv from "dotenv";
import { getConfig } from "./get-config";

/**
 * Represents a plugin's environment variable requirements
 */
interface PluginEnvRequirement {
	name: string;
	description: string;
	required: boolean;
	default?: string;
}

/**
 * Maps plugin names to their required environment variables
 */
const PLUGIN_ENV_REQUIREMENTS: Record<string, PluginEnvRequirement[]> = {
	"@elizaos/plugin-openai": [
		{ name: "OPENAI_API_KEY", description: "OpenAI API key", required: true },
		{
			name: "OPENAI_ORG_ID",
			description: "OpenAI organization ID",
			required: false,
		},
	],
	"@elizaos/plugin-anthropic": [
		{
			name: "ANTHROPIC_API_KEY",
			description: "Anthropic API key",
			required: true,
		},
		{
			name: "ANTHROPIC_SMALL_MODEL",
			description: "Anthropic small model name",
			required: false,
			default: "claude-3-haiku-20240307",
		},
		{
			name: "ANTHROPIC_LARGE_MODEL",
			description: "Anthropic large model name",
			required: false,
			default: "claude-3-opus-20240229",
		},
	],
	"@elizaos/plugin-telegram": [
		{
			name: "TELEGRAM_BOT_TOKEN",
			description: "Telegram bot token",
			required: true,
		},
	],
	"@elizaos/plugin-twitter": [
		{
			name: "TWITTER_USERNAME",
			description: "Twitter username",
			required: true,
		},
		{
			name: "TWITTER_PASSWORD",
			description: "Twitter password",
			required: true,
		},
		{ name: "TWITTER_EMAIL", description: "Twitter email", required: false },
		{
			name: "TWITTER_2FA_SECRET",
			description: "Twitter 2FA secret",
			required: false,
		},
	],
};

/**
 * Locations to search for .env files
 */
const ENV_LOCATIONS = [
	".env", // Current directory
	path.join(os.homedir(), ".env"), // Home directory
	path.join(os.homedir(), ".eliza", ".env"), // Global Eliza config
];

/**
 * Check if an environment variable is set
 */
export function isEnvSet(name: string): boolean {
	return process.env[name] !== undefined;
}

/**
 * Loads environment variables from all possible locations
 */
export async function loadAllEnvFiles(): Promise<void> {
	for (const location of ENV_LOCATIONS) {
		try {
			await fs.stat(location);
			dotenv.config({ path: location });
			logger.info(`Loaded environment variables from ${location}`);
		} catch (error) {
			// File doesn't exist, skip
		}
	}
}

/**
 * Gets plugin environment requirements
 */
export function getPluginEnvRequirements(
	pluginName: string,
): PluginEnvRequirement[] {
	return PLUGIN_ENV_REQUIREMENTS[pluginName] || [];
}

/**
 * Get all required environment variables for installed plugins
 */
export async function getInstalledPluginsEnvRequirements(
	cwd: string,
): Promise<PluginEnvRequirement[]> {
	const config = await getConfig(cwd);
	if (!config) {
		return [];
	}

	const result: PluginEnvRequirement[] = [];
	for (const plugin of config.plugins.installed) {
		const requirements = getPluginEnvRequirements(plugin);
		if (requirements.length > 0) {
			result.push(...requirements);
		}
	}

	return result;
}

/**
 * Checks if all required environment variables are set for a plugin
 */
export function checkPluginEnvRequirements(pluginName: string): {
	missing: PluginEnvRequirement[];
	all: PluginEnvRequirement[];
} {
	const requirements = getPluginEnvRequirements(pluginName);
	const missing = requirements.filter(
		(req) => req.required && !isEnvSet(req.name),
	);

	return { missing, all: requirements };
}

/**
 * Ensures all required environment variables are set
 * Prompts for missing ones and saves them to the specified .env file
 */
export async function ensurePluginEnvRequirements(
	pluginName: string,
	interactive = true,
	envFile = path.join(os.homedir(), ".eliza", ".env"),
): Promise<boolean> {
	// Load all possible .env files first
	await loadAllEnvFiles();

	const { missing, all } = checkPluginEnvRequirements(pluginName);

	// Set defaults for any variables with default values
	all.forEach((req) => {
		if (req.default && !isEnvSet(req.name)) {
			process.env[req.name] = req.default;
			logger.info(`Using default value for ${req.name}: ${req.default}`);
		}
	});

	// Recheck after setting defaults
	const { missing: stillMissing } = checkPluginEnvRequirements(pluginName);

	if (stillMissing.length === 0) {
		return true;
	}

	if (!interactive) {
		logger.warn(`Missing required environment variables for ${pluginName}:`);
		stillMissing.forEach((req) => {
			logger.warn(`  - ${req.name}: ${req.description}`);
		});
		return false;
	}

	// Prepare the directory
	const envDir = path.dirname(envFile);
	await fs.mkdir(envDir, { recursive: true });

	// Read existing content if file exists
	let envContent = "";
	try {
		envContent = await fs.readFile(envFile, "utf-8");
		if (!envContent.endsWith("\n")) {
			envContent += "\n";
		}
	} catch (error) {
		// File doesn't exist yet, that's fine
		envContent = "# Environment variables for Eliza\n\n";
	}

	const prompt = await import("prompts");

	logger.info(`Setting up environment variables for ${pluginName}...`);

	for (const req of stillMissing) {
		const { value } = await prompt.default({
			type: "text",
			name: "value",
			message: `Enter ${req.name} (${req.description})`,
			validate: (value) =>
				req.required && !value ? "This field is required" : true,
		});

		if (value) {
			// Update process.env
			process.env[req.name] = value;

			// Add to file content
			envContent += `${req.name}=${value}\n`;
		}
	}

	// Write back to file
	await fs.writeFile(envFile, envContent);
	logger.success(`Environment variables for ${pluginName} saved to ${envFile}`);

	return true;
}

/**
 * Checks environment variables for all installed plugins
 */
export async function ensureAllPluginsEnvRequirements(
	cwd: string,
	interactive = true,
	skipEnvCheck = false,
): Promise<boolean> {
	if (skipEnvCheck) {
		return true;
	}

	// Load all possible .env files first
	await loadAllEnvFiles();

	const config = await getConfig(cwd);
	if (!config) {
		return true;
	}

	const envFile = existsSync(path.join(cwd, ".env"))
		? path.join(cwd, ".env")
		: path.join(os.homedir(), ".eliza", ".env");

	let allRequirementsMet = true;

	for (const plugin of config.plugins.installed) {
		const pluginRequirementsMet = await ensurePluginEnvRequirements(
			plugin,
			interactive,
			envFile,
		);

		allRequirementsMet = allRequirementsMet && pluginRequirementsMet;
	}

	return allRequirementsMet;
}
