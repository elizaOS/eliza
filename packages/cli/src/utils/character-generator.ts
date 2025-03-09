import type { Character } from "@elizaos/core";
import { character as defaultCharacter } from "../characters/eliza";

/**
 * Maps plugin names to their full package names
 */
const PLUGIN_MAP: Record<string, string> = {
	openai: "@elizaos/plugin-openai",
	anthropic: "@elizaos/plugin-anthropic",
	discord: "@elizaos/plugin-discord",
	twitter: "@elizaos/plugin-twitter",
	telegram: "@elizaos/plugin-telegram",
	sql: "@elizaos/plugin-sql",
};

/**
 * Generates a custom character based on the default character template but with only the selected plugins
 *
 * @param services List of service plugin names to include
 * @param aiModels List of AI model plugin names to include
 * @returns A customized character configuration
 */
export function generateCustomCharacter(
	services: string[] = [],
	aiModels: string[] = [],
): Character {
	// Always include the SQL plugin
	const plugins = ["sql"];

	// Add AI model plugins
	plugins.push(...aiModels);

	// Add service plugins
	plugins.push(...services);

	// Get the unique plugin list
	const uniquePlugins = [...new Set(plugins)];

	// Convert to full package names
	const packageNames = uniquePlugins.map((plugin) => PLUGIN_MAP[plugin]);

	// Create a copy of the default character
	const customCharacter: Character = {
		...JSON.parse(JSON.stringify(defaultCharacter)),
		plugins: packageNames,
	};

	return customCharacter;
}
