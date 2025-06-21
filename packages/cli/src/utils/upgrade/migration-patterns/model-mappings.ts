/**
 * MODEL MAPPINGS MODULE
 *
 * Responsibilities:
 * - Model type transformations from V1 to V2
 * - API method changes and parameter updates
 * - Model class to type conversions
 * - Method signature updates
 */

import type { ModelTypeMapping } from '../types.js';

/**
 * Model type mappings from the mega prompt and plugin-news analysis
 */
export const MODEL_TYPE_MAPPINGS: ModelTypeMapping[] = [
  { v1: 'ModelClass.SMALL', v2: 'ModelType.TEXT_SMALL', description: 'Small text model' },
  { v1: 'ModelClass.LARGE', v2: 'ModelType.TEXT_LARGE', description: 'Large text model' },
  { v1: 'ModelClass', v2: 'ModelType', description: 'Class renamed to Type' },
  { v1: 'stop', v2: 'stopSequences', description: 'Parameter name change' },
  { v1: 'max_tokens', v2: 'maxTokens', description: 'Parameter name change' },
  { v1: 'frequency_penalty', v2: 'frequencyPenalty', description: 'Parameter name change' },
  { v1: 'context', v2: 'prompt', description: 'Context parameter renamed to prompt in useModel' },
  { v1: 'model:', v2: '', description: 'Model type passed as first argument, not in options' },
  // Method changes
  { v1: 'runtime.language.generateText', v2: 'runtime.useModel', description: 'API method change' },
  {
    v1: 'generateObjectDeprecated',
    v2: 'runtime.useModel(ModelType.OBJECT_SMALL, {',
    description: 'CRITICAL: generateObjectDeprecated replaced with runtime.useModel',
  },
  {
    v1: 'runtime.messageManager.createMemory',
    v2: 'runtime.createMemory',
    description: 'Memory API change',
  },
  { v1: 'runtime.memory.create', v2: 'runtime.createMemory', description: 'Memory API change' },
  {
    v1: 'composeContext',
    v2: 'composePromptFromState',
    description: 'CRITICAL: composeContext renamed to composePromptFromState',
  },
  {
    v1: 'runtime.updateRecentMessageState',
    v2: '',
    description: 'CRITICAL: updateRecentMessageState removed in V2',
  },
  { v1: 'elizaLogger', v2: 'logger', description: 'CRITICAL: elizaLogger renamed to logger' },
  // Additional mappings from plugin-news
  { v1: 'presence_penalty', v2: 'presencePenalty', description: 'Parameter name change' },
  { v1: 'top_p', v2: 'topP', description: 'Parameter name change' },
  { v1: 'response_format', v2: 'responseFormat', description: 'Parameter name change' },
  { v1: 'seed', v2: 'seed', description: 'Parameter remains the same' },
  { v1: 'user', v2: 'name', description: 'ActionExample field name change' },
  { v1: 'role', v2: 'name', description: 'Message role field renamed' },
  { v1: 'Account', v2: 'Entity', description: 'Type renamed' },
  { v1: 'userId', v2: 'entityId', description: 'Field renamed' },
  { v1: 'accountId', v2: 'entityId', description: 'Field renamed' },
];

/**
 * Get all model type mappings
 */
export function getModelTypeMappings(): ModelTypeMapping[] {
  return MODEL_TYPE_MAPPINGS;
}

/**
 * Find model mapping by V1 pattern
 */
export function findModelMapping(v1Pattern: string): ModelTypeMapping | undefined {
  return MODEL_TYPE_MAPPINGS.find((mapping) => v1Pattern.includes(mapping.v1));
}

/**
 * Transform model-related code from V1 to V2
 */
export function transformModelCode(code: string): string {
  let transformedCode = code;

  for (const mapping of MODEL_TYPE_MAPPINGS) {
    if (mapping.v2 === '') {
      // Remove patterns where v2 is empty (like 'model:')
      transformedCode = transformedCode.replace(new RegExp(mapping.v1, 'g'), '');
    } else {
      // Replace v1 pattern with v2 pattern
      transformedCode = transformedCode.replace(new RegExp(mapping.v1, 'g'), mapping.v2);
    }
  }

  return transformedCode;
}

/**
 * Get mappings by category
 */
export function getModelMappingsByCategory() {
  return {
    modelTypes: MODEL_TYPE_MAPPINGS.filter((m) => m.v1.includes('ModelClass')),
    parameters: MODEL_TYPE_MAPPINGS.filter((m) => m.v1.includes('_') || m.v1.includes('Penalty')),
    methods: MODEL_TYPE_MAPPINGS.filter((m) => m.v1.includes('runtime.')),
    fields: MODEL_TYPE_MAPPINGS.filter((m) =>
      ['user', 'role', 'Account', 'userId', 'accountId'].includes(m.v1)
    ),
  };
}

/**
 * Check if code needs model transformation
 */
export function needsModelTransformation(code: string): boolean {
  return MODEL_TYPE_MAPPINGS.some((mapping) => code.includes(mapping.v1));
}
