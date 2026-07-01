/**
 * Character Utilities
 *
 * Utilities for managing character secrets, plugins, and model provider detection.
 * These are immutable operations that return new character objects.
 *
 * @module character-utils
 */

import {
	MODEL_PROVIDER_SECRETS as _MODEL_PROVIDER_SECRETS,
	CHANNEL_SECRETS,
} from "./constants/secrets";
import type { Character } from "./types";

// ═══════════════════════════════════════════════════════════════════════════════
// RE-EXPORTS FROM CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mapping of model provider names to their corresponding API key environment variables.
 * @see {@link ./constants/secrets} for the comprehensive list
 */
export const MODEL_PROVIDER_SECRETS = _MODEL_PROVIDER_SECRETS;

export { CHANNEL_SECRETS };

// ═══════════════════════════════════════════════════════════════════════════════
// SECRET MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get a secret value from character.settings.secrets.
 *
 * @param character - The character to get the secret from
 * @param key - The secret key to look up
 * @returns The secret value, or null if not found
 */
export function getCharacterSecret(
	character: Character,
	key: string,
): string | null {
	const secrets = character.settings?.secrets as
		| Record<string, string>
		| undefined;
	const value = secrets?.[key];

	if (value && typeof value === "string" && value.length > 0) {
		return value;
	}

	return null;
}

/**
 * Set a secret in character.settings.secrets. This is an immutable operation
 * that returns a new character object.
 *
 * @param character - The character to modify
 * @param key - The secret key to set
 * @param value - The secret value
 * @returns A new character with the secret set
 */
export function setCharacterSecret(
	character: Character,
	key: string,
	value: string,
): Character {
	const secrets = (character.settings?.secrets as Record<string, string>) ?? {};

	return {
		...character,
		settings: {
			...character.settings,
			secrets: {
				...secrets,
				[key]: value,
			},
		},
	};
}

/**
 * Check if a secret exists in character.settings.secrets.
 *
 * @param character - The character to check
 * @param key - The secret key to look for
 * @returns true if the secret exists and has a non-empty value
 */
export function hasCharacterSecret(character: Character, key: string): boolean {
	return getCharacterSecret(character, key) !== null;
}

/**
 * Delete a secret from character.settings.secrets. This is an immutable operation
 * that returns a new character object.
 *
 * @param character - The character to modify
 * @param key - The secret key to delete
 * @returns A new character with the secret removed
 */
export function deleteCharacterSecret(
	character: Character,
	key: string,
): Character {
	const secrets = (character.settings?.secrets as Record<string, string>) ?? {};
	const { [key]: _removed, ...remaining } = secrets;

	return {
		...character,
		settings: {
			...character.settings,
			secrets: remaining,
		},
	};
}

/**
 * List all secret keys (not values) from character.settings.secrets.
 *
 * @param character - The character to list secrets from
 * @returns Array of secret key names
 */
export function listCharacterSecretKeys(character: Character): string[] {
	const secrets = character.settings?.secrets as
		| Record<string, string>
		| undefined;
	if (!secrets) return [];
	return Object.keys(secrets);
}

/**
 * Merge secrets into character.settings.secrets. Existing character secrets
 * take priority and are not overwritten.
 *
 * @param character - The character to merge secrets into
 * @param secrets - The secrets to merge
 * @returns A new character with the merged secrets
 */
export function mergeCharacterSecrets(
	character: Character,
	secrets: Record<string, string>,
): Character {
	const existingSecrets =
		(character.settings?.secrets as Record<string, string>) ?? {};

	// Merge secrets - existing secrets take priority
	const mergedSecrets: Record<string, string> = { ...secrets };
	for (const [key, value] of Object.entries(existingSecrets)) {
		if (value && typeof value === "string") {
			mergedSecrets[key] = value;
		}
	}

	return {
		...character,
		settings: {
			...character.settings,
			secrets: mergedSecrets,
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLUGIN MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Add a plugin to character.plugins. This is an immutable operation.
 * If the plugin is already present, the original character is returned.
 *
 * @param character - The character to modify
 * @param pluginName - The plugin name to add (e.g., "@elizaos/plugin-discord")
 * @returns A new character with the plugin added, or the original if already present
 */
export function addCharacterPlugin(
	character: Character,
	pluginName: string,
): Character {
	const plugins = character.plugins ?? [];
	if (plugins.includes(pluginName)) {
		return character;
	}

	return {
		...character,
		plugins: [...plugins, pluginName],
	};
}

/**
 * Remove a plugin from character.plugins. This is an immutable operation.
 *
 * @param character - The character to modify
 * @param pluginName - The plugin name to remove
 * @returns A new character with the plugin removed
 */
export function removeCharacterPlugin(
	character: Character,
	pluginName: string,
): Character {
	const plugins = character.plugins ?? [];

	return {
		...character,
		plugins: plugins.filter((p) => p !== pluginName),
	};
}

/**
 * Check if a plugin is enabled on the character.
 *
 * @param character - The character to check
 * @param pluginName - The plugin name to look for
 * @returns true if the plugin is in character.plugins
 */
export function hasCharacterPlugin(
	character: Character,
	pluginName: string,
): boolean {
	return character.plugins?.includes(pluginName) ?? false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL PROVIDER DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect which AI model provider is configured based on available API keys.
 *
 * @param character - The character to check
 * @returns The provider name (e.g., "anthropic", "openai") or null if none found
 */
export function getModelProvider(character: Character): string | null {
	for (const [provider, secretKey] of Object.entries(MODEL_PROVIDER_SECRETS)) {
		if (hasCharacterSecret(character, secretKey)) {
			return provider;
		}
	}
	return null;
}

/**
 * Get all configured model providers for a character.
 *
 * @param character - The character to check
 * @returns Array of provider names that have API keys configured
 */
export function getConfiguredModelProviders(character: Character): string[] {
	const providers: string[] = [];
	for (const [provider, secretKey] of Object.entries(MODEL_PROVIDER_SECRETS)) {
		if (hasCharacterSecret(character, secretKey)) {
			providers.push(provider);
		}
	}
	return providers;
}
