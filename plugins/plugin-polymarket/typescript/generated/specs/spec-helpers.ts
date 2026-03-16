/**
 * Helper functions to lookup action/provider/evaluator specs by name.
 * These allow language-specific implementations to import their text content
 * (description, similes, examples) from the centralized specs.
 *
 * DO NOT EDIT the spec data - update prompts/actions.json, prompts/providers.json, prompts/evaluators.json and regenerate.
 */

import {
  type ActionDoc,
  allActionDocs,
  allEvaluatorDocs,
  allProviderDocs,
  coreActionDocs,
  coreEvaluatorDocs,
  coreProviderDocs,
  type EvaluatorDoc,
  type ProviderDoc,
} from "./specs";

// Build lookup maps for O(1) access
const coreActionMap = new Map<string, ActionDoc>(coreActionDocs.map((doc) => [doc.name, doc]));
const allActionMap = new Map<string, ActionDoc>(allActionDocs.map((doc) => [doc.name, doc]));
const coreProviderMap = new Map<string, ProviderDoc>(
  coreProviderDocs.map((doc) => [doc.name, doc]),
);
const allProviderMap = new Map<string, ProviderDoc>(allProviderDocs.map((doc) => [doc.name, doc]));
const coreEvaluatorMap = new Map<string, EvaluatorDoc>(
  coreEvaluatorDocs.map((doc) => [doc.name, doc]),
);
const allEvaluatorMap = new Map<string, EvaluatorDoc>(
  allEvaluatorDocs.map((doc) => [doc.name, doc]),
);

/**
 * Get an action spec by name from the core specs.
 * @param name - The action name
 * @returns The action spec or undefined if not found
 */
export function getActionSpec(name: string): ActionDoc | undefined {
  return coreActionMap.get(name) ?? allActionMap.get(name);
}

/**
 * Get an action spec by name, returning a fallback if not found.
 * @param name - The action name
 * @returns The action spec or a fallback spec
 */
export function requireActionSpec(name: string): ActionDoc {
  const spec = getActionSpec(name);
  if (!spec) {
    // Return a fallback spec instead of throwing to allow graceful degradation
    return {
      name,
      description: `${name} action`,
      similes: [],
      parameters: [],
      examples: [],
    };
  }
  return spec;
}

/**
 * Get a provider spec by name from the core specs.
 * @param name - The provider name
 * @returns The provider spec or undefined if not found
 */
export function getProviderSpec(name: string): ProviderDoc | undefined {
  return coreProviderMap.get(name) ?? allProviderMap.get(name);
}

/**
 * Get a provider spec by name, returning a fallback if not found.
 * @param name - The provider name
 * @returns The provider spec or a fallback spec
 */
export function requireProviderSpec(name: string): ProviderDoc {
  const spec = getProviderSpec(name);
  if (!spec) {
    // Return a fallback spec instead of throwing to allow graceful degradation
    return {
      name,
      description: `${name} provider`,
      dynamic: true,
    };
  }
  return spec;
}

/**
 * Get an evaluator spec by name from the core specs.
 * @param name - The evaluator name
 * @returns The evaluator spec or undefined if not found
 */
export function getEvaluatorSpec(name: string): EvaluatorDoc | undefined {
  return coreEvaluatorMap.get(name) ?? allEvaluatorMap.get(name);
}

/**
 * Get an evaluator spec by name, returning a fallback if not found.
 * @param name - The evaluator name
 * @returns The evaluator spec or a fallback spec
 */
export function requireEvaluatorSpec(name: string): EvaluatorDoc {
  const spec = getEvaluatorSpec(name);
  if (!spec) {
    // Return a fallback spec instead of throwing to allow graceful degradation
    return {
      name,
      description: `${name} evaluator`,
      alwaysRun: false,
    };
  }
  return spec;
}

// Re-export types for convenience
export type { ActionDoc, ProviderDoc, EvaluatorDoc };
