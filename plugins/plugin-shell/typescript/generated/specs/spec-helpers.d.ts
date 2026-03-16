/**
 * Helper functions to lookup action/provider/evaluator specs by name.
 * These allow language-specific implementations to import their text content
 * (description, similes, examples) from the centralized specs.
 *
 * DO NOT EDIT the spec data - update prompts/actions.json, prompts/providers.json, prompts/evaluators.json and regenerate.
 */
import { type ActionDoc, type EvaluatorDoc, type ProviderDoc } from "./specs";
/**
 * Get an action spec by name from the core specs.
 * @param name - The action name
 * @returns The action spec or undefined if not found
 */
export declare function getActionSpec(name: string): ActionDoc | undefined;
/**
 * Get an action spec by name, throwing if not found.
 * @param name - The action name
 * @returns The action spec
 * @throws Error if the action is not found
 */
export declare function requireActionSpec(name: string): ActionDoc;
/**
 * Get a provider spec by name from the core specs.
 * @param name - The provider name
 * @returns The provider spec or undefined if not found
 */
export declare function getProviderSpec(name: string): ProviderDoc | undefined;
/**
 * Get a provider spec by name, throwing if not found.
 * @param name - The provider name
 * @returns The provider spec
 * @throws Error if the provider is not found
 */
export declare function requireProviderSpec(name: string): ProviderDoc;
/**
 * Get an evaluator spec by name from the core specs.
 * @param name - The evaluator name
 * @returns The evaluator spec or undefined if not found
 */
export declare function getEvaluatorSpec(name: string): EvaluatorDoc | undefined;
/**
 * Get an evaluator spec by name, throwing if not found.
 * @param name - The evaluator name
 * @returns The evaluator spec
 * @throws Error if the evaluator is not found
 */
export declare function requireEvaluatorSpec(name: string): EvaluatorDoc;
export type { ActionDoc, ProviderDoc, EvaluatorDoc };
