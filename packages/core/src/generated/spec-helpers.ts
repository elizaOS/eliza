/**
 * Helper functions to lookup action/provider specs by name.
 * These allow language-specific implementations to import their text content
 * (description, similes, examples) from the centralized specs.
 *
 * DO NOT EDIT the spec data - update packages/prompts/specs/** and regenerate.
 */

import {
	type ActionDoc,
	allActionDocs,
	allProviderDocs,
	coreActionDocs,
	coreProviderDocs,
	type ProviderDoc,
} from "./action-docs";

// Build lookup maps for O(1) access
const coreActionMap = new Map<string, ActionDoc>(
	coreActionDocs.map((doc) => [doc.name, doc]),
);
const allActionMap = new Map<string, ActionDoc>(
	allActionDocs.map((doc) => [doc.name, doc]),
);
const coreProviderMap = new Map<string, ProviderDoc>(
	coreProviderDocs.map((doc) => [doc.name, doc]),
);
const allProviderMap = new Map<string, ProviderDoc>(
	allProviderDocs.map((doc) => [doc.name, doc]),
);

/**
 * Get an action spec by name from the core specs.
 * @param name - The action name (e.g., "REPLY", "IGNORE")
 * @returns The action spec or undefined if not found
 */
export function getActionSpec(name: string): ActionDoc | undefined {
	return coreActionMap.get(name) ?? allActionMap.get(name);
}

/**
 * Get an action spec by name, throwing if not found.
 * @param name - The action name
 * @returns The action spec
 * @throws Error if the action is not found
 */
export function requireActionSpec(name: string): ActionDoc {
	const spec = getActionSpec(name);
	if (!spec) {
		throw new Error(`Action spec not found: ${name}`);
	}
	return spec;
}

/**
 * Get a provider spec by name from the core specs.
 * @param name - The provider name (e.g., "CHARACTER", "TIME")
 * @returns The provider spec or undefined if not found
 */
export function getProviderSpec(name: string): ProviderDoc | undefined {
	return coreProviderMap.get(name) ?? allProviderMap.get(name);
}

/**
 * Get a provider spec by name, throwing if not found.
 * @param name - The provider name
 * @returns The provider spec
 * @throws Error if the provider is not found
 */
export function requireProviderSpec(name: string): ProviderDoc {
	const spec = getProviderSpec(name);
	if (!spec) {
		throw new Error(`Provider spec not found: ${name}`);
	}
	return spec;
}

// Re-export types for convenience
export type { ActionDoc, ProviderDoc };
