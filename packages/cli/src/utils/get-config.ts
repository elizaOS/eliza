import path from "node:path";
import { cosmiconfig } from "cosmiconfig";
import { z } from "zod";
import { existsSync } from "node:fs";
import os from "node:os";
import { promises as fs } from "node:fs";
import dotenv from "dotenv";

const explorer = cosmiconfig("eliza", {
	searchPlaces: ["project.json"],
});

// Database config schemas
const postgresConfigSchema = z.object({
	type: z.literal("postgres"),
	config: z.object({
		url: z.string(),
	}),
});

const pgliteConfigSchema = z.object({
	type: z.literal("pglite"),
	config: z.object({
		dataDir: z.string(),
	}),
});

// Main config schema
/**
 * Schema definition for the raw configuration object.
 *
 * @type {z.ZodType<RawConfig>}
 */
export const rawConfigSchema = z
	.object({
		$schema: z.string().optional(),
		database: z.discriminatedUnion("type", [
			postgresConfigSchema,
			pgliteConfigSchema,
		]),
		plugins: z.object({
			registry: z.string().url(),
			installed: z.array(z.string()),
		}),
		paths: z.object({
			knowledge: z.string(),
		}),
	})
	.strict();

/**
 * Type definition for the inferred type of the raw config schema.
 */
export type RawConfig = z.infer<typeof rawConfigSchema>;

export const configSchema = rawConfigSchema.extend({
	resolvedPaths: z.object({
		knowledge: z.string(),
	}),
});

/**
 * Define the type `Config` as the inferred type from the `configSchema`.
 */
export type Config = z.infer<typeof configSchema>;

/**
 * Gets the configuration for the given current working directory.
 * @param {string} cwd - The current working directory
 * @returns {Promise<object | null>} The resolved configuration object, or null if no configuration is found
 */
export async function getConfig(cwd: string) {
	const config = await getRawConfig(cwd);

	if (!config) {
		return null;
	}

	return await resolveConfigPaths(cwd, config);
}

/**
 * Resolves the paths in the given configuration based on the provided current working directory (cwd).
 * @param {string} cwd - The current working directory.
 * @param {RawConfig} config - The raw configuration object.
 * @returns {Promise<ResolvedConfig>} The resolved configuration object with updated paths.
 */
export async function resolveConfigPaths(cwd: string, config: RawConfig) {
	return configSchema.parse({
		...config,
		resolvedPaths: {
			knowledge: path.resolve(cwd, config.paths.knowledge),
		},
	});
}

/**
 * Retrieves the raw configuration object for the specified directory.
 * @param {string} cwd - The current working directory.
 * @returns {Promise<RawConfig | null>} A promise that resolves to the raw configuration object, or null if no configuration is found.
 * @throws {Error} If an invalid configuration is found in the project.json file within the specified directory.
 */
export async function getRawConfig(cwd: string): Promise<RawConfig | null> {
	try {
		const configResult = await explorer.search(cwd);

		if (!configResult) {
			return null;
		}

		return rawConfigSchema.parse(configResult.config);
	} catch (_error) {
		throw new Error(`Invalid configuration found in ${cwd}/project.json.`);
	}
}

/**
 * Load environment variables, trying project .env first, then global ~/.eliza/.env
 */
/**
 * Loads environment variables from either the project directory or global config.
 * If the .env file is found in the project directory, it will be loaded.
 * If not found in the project directory, it will try to load from the global config.
 * If neither exist, it will create the global .env file with a default comment.
 *
 * @param {string} projectDir - The directory where the project is located (default: process.cwd()).
 * @returns {Promise<void>} A Promise that resolves once the environment variables are loaded or created.
 */
export async function loadEnvironment(
	projectDir: string = process.cwd(),
): Promise<void> {
	const projectEnvPath = path.join(projectDir, ".env");
	const globalEnvDir = path.join(os.homedir(), ".eliza");
	const globalEnvPath = path.join(globalEnvDir, ".env");

	// First try loading from project directory
	if (existsSync(projectEnvPath)) {
		dotenv.config({ path: projectEnvPath });
		return;
	}

	// If not found, try loading from global config
	if (existsSync(globalEnvPath)) {
		dotenv.config({ path: globalEnvPath });
		return;
	}

	// If neither exists, create the global .env
	if (!existsSync(globalEnvDir)) {
		await fs.mkdir(globalEnvDir, { recursive: true });
	}

	// Create an empty .env file
	if (!existsSync(globalEnvPath)) {
		await fs.writeFile(
			globalEnvPath,
			"# Global environment variables for Eliza\n",
		);
	}
}
