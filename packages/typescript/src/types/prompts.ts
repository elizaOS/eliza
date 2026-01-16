/**
 * Shared types for prompt building and template composition.
 *
 * These types are used across plugins to ensure consistent prompt handling
 * and to enable shared prompt building utilities.
 */

import type { TemplateType } from "./agent.js";
import type {
  BuildPromptOptions as ProtoBuildPromptOptions,
  BuiltPrompt as ProtoBuiltPrompt,
  PromptFieldInfo as ProtoPromptFieldInfo,
  PromptTemplateConfig as ProtoPromptTemplateConfig,
} from "./proto.js";

/**
 * Information about a field for prompt building.
 * Used when building prompts that extract or format field values.
 */
export type PromptFieldInfo = ProtoPromptFieldInfo;

/**
 * Options for building a prompt from a template.
 */
export interface BuildPromptOptions
  extends Omit<ProtoBuildPromptOptions, "template" | "state" | "defaults"> {
  template: TemplateType;
  state: Record<string, string | number | boolean | undefined>;
  defaults?: Record<string, string>;
}

/**
 * Result of building a prompt from a template.
 */
export type BuiltPrompt = ProtoBuiltPrompt;

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
export interface PromptTemplateConfig
  extends Omit<ProtoPromptTemplateConfig, "template" | "defaults"> {
  template: TemplateType;
  defaults?: Record<string, string>;
  builder?: PromptBuilder;
}
