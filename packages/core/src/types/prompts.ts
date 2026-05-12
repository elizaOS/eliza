/**
 * Shared types for prompt building and template composition.
 *
 * These types are used across plugins to ensure consistent prompt handling
 * and to enable shared prompt building utilities.
 */

import type { TemplateType } from "./agent.js";

/**
 * Information about a field for prompt building.
 * Used when building prompts that extract or format field values.
 */
export interface PromptFieldInfo {
	id: string;
	type: string;
	label: string;
	description?: string;
	criteria?: string;
}

/**
 * Options for building a prompt from a template.
 */
export interface BuildPromptOptions {
	template: TemplateType;
	state: Record<string, string | number | boolean | undefined>;
	defaults?: Record<string, string>;
}

/**
 * Result of building a prompt from a template.
 */
export interface BuiltPrompt {
	prompt: string;
	system?: string;
	substitutedVariables: string[];
	missingVariables: string[];
}

/**
 * Function signature for building prompts dynamically.
 */
export type PromptBuilder = (
	options: BuildPromptOptions,
) => string | BuiltPrompt;

/**
 * Configuration for a prompt template.
 * Extends the basic template with metadata and building options.
 */
export interface PromptTemplateConfig {
	template: TemplateType;
	name: string;
	description?: string;
	defaults?: Record<string, string>;
	requiredVariables?: string[];
	optionalVariables?: string[];
	builder?: PromptBuilder;
}
