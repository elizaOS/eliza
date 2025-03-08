import { config } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import logger from "./logger";

/**
 * Interface for settings object with key-value pairs.
 */
interface Settings {
	[key: string]: string | undefined;
}

/**
 * Represents a collection of settings grouped by namespace.
 *
 * @typedef {Object} NamespacedSettings
 * @property {Settings} namespace - The namespace key and corresponding Settings value.
 */
interface NamespacedSettings {
	[namespace: string]: Settings;
}

/**
 * Initialize an empty object for storing environment settings.
 */
let environmentSettings: Settings = {};

/**
 * Determines if code is running in a browser environment
 * @returns {boolean} True if in browser environment
 */
const isBrowser = (): boolean => {
	return (
		typeof window !== "undefined" && typeof window.document !== "undefined"
	);
};

/**
 * Recursively searches for a .env file starting from the current directory
 * and moving up through parent directories (Node.js only)
 * @param {string} [startDir=process.cwd()] - Starting directory for the search
 * @returns {string|null} Path to the nearest .env file or null if not found
 */
export function findNearestEnvFile(startDir = process.cwd()) {
	if (isBrowser()) return null;

	let currentDir = startDir;

	// Continue searching until we reach the root directory
	while (currentDir !== path.parse(currentDir).root) {
		const envPath = path.join(currentDir, ".env");

		if (fs.existsSync(envPath)) {
			return envPath;
		}

		// Move up to parent directory
		currentDir = path.dirname(currentDir);
	}

	// Check root directory as well
	const rootEnvPath = path.join(path.parse(currentDir).root, ".env");
	return fs.existsSync(rootEnvPath) ? rootEnvPath : null;
}

/**
 * Configures environment settings for browser usage
 * @param {Settings} settings - Object containing environment variables
 */
export function configureSettings(settings: Settings) {
	environmentSettings = { ...settings };
}

/**
 * Loads environment variables from the nearest .env file in Node.js
 * or returns configured settings in browser
 * @returns {Settings} Environment variables object
 * @throws {Error} If no .env file is found in Node.js environment
 */
export function loadEnvConfig(): Settings {
	// For browser environments, return the configured settings
	if (isBrowser()) {
		return environmentSettings;
	}

	// Node.js environment: load from .env file
	const envPath = findNearestEnvFile();

	// attempt to Load the .env file into process.env
	const result = config(envPath ? { path: envPath } : {});

	if (!result.error) {
		logger.log(`Loaded .env file from: ${envPath}`);
	}

	// Parse namespaced settings
	const namespacedSettings = parseNamespacedSettings(process.env as Settings);

	// Attach to process.env for backward compatibility
	Object.entries(namespacedSettings).forEach(([namespace, settings]) => {
		process.env[`__namespaced_${namespace}`] = JSON.stringify(settings);
	});

	return process.env as Settings;
}

/**
 * Gets a specific environment variable
 * @param {string} key - The environment variable key
 * @param {string} [defaultValue] - Optional default value if key doesn't exist
 * @returns {string|undefined} The environment variable value or default value
 */
export function getEnvVariable(
	key: string,
	defaultValue?: string,
): string | undefined {
	if (isBrowser()) {
		return environmentSettings[key] || defaultValue;
	}
	return process.env[key] || defaultValue;
}

/**
 * Checks if a specific environment variable exists
 * @param {string} key - The environment variable key
 * @returns {boolean} True if the environment variable exists
 */
export function hasEnvVariable(key: string): boolean {
	if (isBrowser()) {
		return key in environmentSettings;
	}
	return key in process.env;
}

// Add this function to parse namespaced settings
function parseNamespacedSettings(env: Settings): NamespacedSettings {
	const namespaced: NamespacedSettings = {};

	for (const [key, value] of Object.entries(env)) {
		if (!value) continue;

		const [namespace, ...rest] = key.split(".");
		if (!namespace || rest.length === 0) continue;

		const settingKey = rest.join(".");
		namespaced[namespace] = namespaced[namespace] || {};
		namespaced[namespace][settingKey] = value;
	}

	return namespaced;
}

// Initialize settings based on environment
export const settings = isBrowser() ? environmentSettings : loadEnvConfig();

// Helper schemas for nested types
export const MessageExampleSchema = z.object({
	name: z.string(),
	content: z
		.object({
			text: z.string(),
			action: z.string().optional(),
			source: z.string().optional(),
			url: z.string().optional(),
			inReplyTo: z.string().uuid().optional(),
			attachments: z.array(z.any()).optional(),
		})
		.and(z.record(z.string(), z.unknown())), // For additional properties
});

export const PluginSchema = z.object({
	name: z.string(),
	description: z.string(),
	actions: z.array(z.any()).optional(),
	providers: z.array(z.any()).optional(),
	evaluators: z.array(z.any()).optional(),
	services: z.array(z.any()).optional(),
	clients: z.array(z.any()).optional(),
});

// Main Character schema
export const CharacterSchema = z.object({
	id: z.string().uuid().optional(),
	name: z.string(),
	system: z.string().optional(),
	templates: z.record(z.string()).optional(),
	bio: z.union([z.string(), z.array(z.string())]),
	messageExamples: z.array(z.array(MessageExampleSchema)),
	postExamples: z.array(z.string()),
	topics: z.array(z.string()),
	adjectives: z.array(z.string()),
	knowledge: z
		.array(
			z.union([
				z.string(), // Direct knowledge strings
				z.object({
					// Individual file config
					path: z.string(),
					shared: z.boolean().optional(),
				}),
				z.object({
					// Directory config
					directory: z.string(),
					shared: z.boolean().optional(),
				}),
			]),
		)
		.optional(),
	plugins: z.union([z.array(z.string()), z.array(PluginSchema)]),
	settings: z
		.object({
			secrets: z.record(z.string()).optional(),
			voice: z
				.object({
					model: z.string().optional(),
					url: z.string().optional(),
				})
				.optional(),
			model: z.string().optional(),
			modelConfig: z
				.object({
					maxInputTokens: z.number().optional(),
					maxOutputTokens: z.number().optional(),
					temperature: z.number().optional(),
					frequency_penalty: z.number().optional(),
					presence_penalty: z.number().optional(),
				})
				.optional(),
			embeddingModel: z.string().optional(),
		})
		.optional(),
	style: z.object({
		all: z.array(z.string()),
		chat: z.array(z.string()),
		post: z.array(z.string()),
	}),
});

// Type inference
export type CharacterConfig = z.infer<typeof CharacterSchema>;

// Validation function
export function validateCharacterConfig(json: unknown): CharacterConfig {
	try {
		return CharacterSchema.parse(json);
	} catch (error) {
		if (error instanceof z.ZodError) {
			const groupedErrors = error.errors.reduce(
				(acc, err) => {
					const path = err.path.join(".");
					if (!acc[path]) {
						acc[path] = [];
					}
					acc[path].push(err.message);
					return acc;
				},
				{} as Record<string, string[]>,
			);

			for (const field in groupedErrors) {
				logger.error(
					`Validation errors in ${field}: ${groupedErrors[field].join(" - ")}`,
				);
			}

			throw new Error(
				"Character configuration validation failed. Check logs for details.",
			);
		}
		throw error;
	}
}
