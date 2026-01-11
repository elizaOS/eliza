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
  /** Unique identifier for the field */
  id: string;

  /** Field type (e.g., "text", "email", "number") */
  type: string;

  /** Display label for the field */
  label: string;

  /** Optional field description */
  description?: string;

  /** Optional validation criteria */
  criteria?: string;
}

/**
 * Options for building a prompt from a template.
 */
export interface BuildPromptOptions {
  /** The template string or function */
  template: TemplateType;

  /** State values to substitute into the template */
  state: Record<string, string | number | boolean | undefined>;

  /** Optional default values for template variables */
  defaults?: Record<string, string>;
}

/**
 * Result of building a prompt from a template.
 */
export interface BuiltPrompt {
  /** The final prompt string with all substitutions applied */
  prompt: string;

  /** Optional system prompt (for multi-part prompts) */
  system?: string;

  /** Variables that were substituted */
  substitutedVariables?: string[];

  /** Variables that were missing from state */
  missingVariables?: string[];
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
  /** The template string or function */
  template: TemplateType;

  /** Template name/identifier */
  name: string;

  /** Template description */
  description?: string;

  /** Default values for template variables */
  defaults?: Record<string, string>;

  /** Optional custom builder function */
  builder?: PromptBuilder;

  /** Required variables (for validation) */
  requiredVariables?: string[];

  /** Optional variables */
  optionalVariables?: string[];
}
