/**
 * IMPORT MAPPINGS MODULE
 *
 * Responsibilities:
 * - Critical import transformations from V1 to V2
 * - Type-only import separations
 * - Mixed import pattern handling
 * - Import validation and correction
 * - Provider-specific import patterns
 */

import type { ImportMapping } from '../types.js';

/**
 * Critical import mappings from the mega prompt and plugin-news analysis
 */
export const IMPORT_MAPPINGS: ImportMapping[] = [
  // CRITICAL V2 Import Name Changes (Simple String Replacements)
  {
    oldImport: 'ModelClass',
    newImport: 'ModelType',
    description: 'CRITICAL: ModelClass is renamed to ModelType in V2',
  },
  {
    oldImport: 'elizaLogger',
    newImport: 'logger',
    description: 'CRITICAL: elizaLogger is renamed to logger in V2',
  },
  {
    oldImport: 'composeContext',
    newImport: 'composePromptFromState',
    description: 'CRITICAL: composeContext is renamed to composePromptFromState in V2',
  },

  // CRITICAL: Remove V1-only imports that no longer exist
  {
    oldImport: 'generateObjectDeprecated',
    newImport: '',
    description:
      'CRITICAL: generateObjectDeprecated removed in V2 - use runtime.useModel + parseKeyValueXml',
  },

  // NEW: Additional V1→V2 import name changes from knowledge base
  {
    oldImport: 'generateObject',
    newImport: '',
    description:
      'CRITICAL: generateObject removed in V2 - use runtime.useModel with appropriate ModelType',
  },

  // CRITICAL: Add V2-only imports needed for migration
  {
    oldImport: '',
    newImport: 'parseKeyValueXml',
    description: 'CRITICAL: Add parseKeyValueXml import for V2 model response parsing',
  },

  // NEW: Additional V2 imports needed for common patterns
  {
    oldImport: '',
    newImport: 'createUniqueUuid',
    description: 'CRITICAL: Add createUniqueUuid import for memory creation patterns',
  },

  // PROVIDER-SPECIFIC EXTERNAL DEPENDENCY REMOVAL
  {
    oldImport: 'import { DeriveKeyProvider, TEEMode } from "@elizaos/plugin-tee"',
    newImport: '',
    description: 'CRITICAL: Remove external TEE plugin dependency - use runtime service registry',
  },
  {
    oldImport: 'import NodeCache from "node-cache"',
    newImport: '',
    description: 'CRITICAL: Remove NodeCache dependency - use runtime caching',
  },
  {
    oldImport: 'import { ICacheManager }',
    newImport: '',
    description: 'CRITICAL: Remove ICacheManager import - use IAgentRuntime',
  },

  // PROVIDER-SPECIFIC NEW IMPORTS
  {
    oldImport: '',
    newImport: 'import { ServiceType } from "@elizaos/core"',
    description: 'CRITICAL: Add ServiceType import for service integration',
  },
  {
    oldImport: '',
    newImport: 'import { ProviderResult } from "@elizaos/core"',
    description: 'CRITICAL: Add ProviderResult type for structured provider responses',
  },
  {
    oldImport: '',
    newImport: 'import * as path from "node:path"',
    description: 'CRITICAL: Add path import for cache key construction',
  },

  // PROVIDER CONSTRUCTOR PATTERN IMPORTS
  {
    oldImport: 'constructor(privateKey: string, private cacheManager: ICacheManager',
    newImport: 'constructor(privateKey: string, runtime: IAgentRuntime',
    description: 'CRITICAL: Replace ICacheManager with IAgentRuntime in constructor',
  },

  // PROVIDER SERVICE INTEGRATION IMPORTS
  {
    oldImport: '',
    newImport: 'import { [PLUGIN]_SERVICE_NAME } from "../constants"',
    description: 'CRITICAL: Add service name constant import for provider integration',
  },

  // CRITICAL Type-Only Imports (Must be separated)
  {
    oldImport: '{ TestSuite }',
    newImport: 'type { TestSuite }',
    description: 'CRITICAL: TestSuite is type-only export in V2',
  },
  {
    oldImport: '{ ActionExample }',
    newImport: 'type { ActionExample }',
    description: 'CRITICAL: ActionExample is type-only export in V2',
  },
  {
    oldImport: '{ Content }',
    newImport: 'type { Content }',
    description: 'CRITICAL: Content is type-only export in V2',
  },
  {
    oldImport: '{ HandlerCallback }',
    newImport: 'type { HandlerCallback }',
    description: 'CRITICAL: HandlerCallback is type-only export in V2',
  },
  {
    oldImport: '{ IAgentRuntime }',
    newImport: 'type { IAgentRuntime }',
    description: 'CRITICAL: IAgentRuntime is type-only export in V2',
  },
  {
    oldImport: '{ State }',
    newImport: 'type { State }',
    description: 'CRITICAL: State is type-only export in V2',
  },

  // NEW: Additional critical type-only imports
  {
    oldImport: '{ UUID }',
    newImport: 'type { UUID }',
    description: 'CRITICAL: UUID is type-only export in V2',
  },
  {
    oldImport: '{ Plugin }',
    newImport: 'type { Plugin }',
    description: 'CRITICAL: Plugin is type-only export in V2',
  },
  {
    oldImport: '{ Provider }',
    newImport: 'type { Provider }',
    description: 'CRITICAL: Provider is type-only export in V2',
  },
  {
    oldImport: '{ Memory }',
    newImport: 'type { Memory }',
    description: 'CRITICAL: Memory is type-only export in V2',
  },
  {
    oldImport: '{ Action }',
    newImport: 'type { Action }',
    description: 'CRITICAL: Action is type-only export in V2',
  },

  // NEW: Additional interface and enum imports that should be type-only
  {
    oldImport: '{ ServiceType }',
    newImport: 'type { ServiceType }',
    description: 'CRITICAL: ServiceType is type-only export in V2',
  },
  {
    oldImport: '{ Evaluator }',
    newImport: 'type { Evaluator }',
    description: 'CRITICAL: Evaluator is type-only export in V2',
  },
  {
    oldImport: '{ Character }',
    newImport: 'type { Character }',
    description: 'CRITICAL: Character is type-only export in V2',
  },

  // PROVIDER-SPECIFIC TYPE IMPORTS
  {
    oldImport: '{ ProviderResult }',
    newImport: 'type { ProviderResult }',
    description: 'CRITICAL: ProviderResult is type-only export in V2',
  },

  // CRITICAL Mixed Import Separations (Common Patterns)
  {
    oldImport: '{ Service, type IAgentRuntime }',
    newImport: '{ Service } from "@elizaos/core";\nimport type { IAgentRuntime }',
    description: 'CRITICAL: Separate mixed imports - Service is value, IAgentRuntime is type',
  },
  {
    oldImport: '{ Memory, type State }',
    newImport: '{ Memory } from "@elizaos/core";\nimport type { State }',
    description: 'CRITICAL: Separate mixed imports - Memory is value, State is type',
  },
  {
    oldImport: '{ ActionExample, Content }',
    newImport: 'type { ActionExample, Content }',
    description: 'CRITICAL: Both ActionExample and Content are type-only in V2',
  },
  {
    oldImport: '{ HandlerCallback, IAgentRuntime }',
    newImport: 'type { HandlerCallback, IAgentRuntime }',
    description: 'CRITICAL: Both HandlerCallback and IAgentRuntime are type-only in V2',
  },

  // NEW: Complex mixed import patterns that need separation
  {
    oldImport: '{ Service, type Provider, type Action }',
    newImport: '{ Service } from "@elizaos/core";\nimport type { Provider, Action }',
    description: 'CRITICAL: Separate Service (value) from Provider, Action (types)',
  },
  {
    oldImport: '{ logger, ModelType, type Memory, type State }',
    newImport: '{ logger, ModelType } from "@elizaos/core";\nimport type { Memory, State }',
    description: 'CRITICAL: Separate values (logger, ModelType) from types (Memory, State)',
  },
  {
    oldImport: '{ createUniqueUuid, type UUID, type Content }',
    newImport: '{ createUniqueUuid } from "@elizaos/core";\nimport type { UUID, Content }',
    description: 'CRITICAL: Separate createUniqueUuid (value) from UUID, Content (types)',
  },

  // PROVIDER-SPECIFIC MIXED IMPORT PATTERNS
  {
    oldImport: '{ elizaLogger, type ProviderResult, type IAgentRuntime }',
    newImport:
      '{ elizaLogger } from "@elizaos/core";\nimport type { ProviderResult, IAgentRuntime }',
    description:
      'CRITICAL: Separate elizaLogger (value) from types (ProviderResult, IAgentRuntime)',
  },
  {
    oldImport: '{ ServiceType, type Provider, elizaLogger }',
    newImport: '{ ServiceType, elizaLogger } from "@elizaos/core";\nimport type { Provider }',
    description: 'CRITICAL: Separate values (ServiceType, elizaLogger) from Provider (type)',
  },

  // CRITICAL Removed Imports
  {
    oldImport: '{ AgentTest }',
    newImport: '',
    description: 'CRITICAL: AgentTest does not exist in V2 - remove completely',
  },

  // NEW: Import patterns that frequently cause issues
  {
    oldImport: /import\s*{\s*([^}]*),\s*type\s+([^}]*)\s*}\s*from\s*["']@elizaos\/core["']/g,
    newImport: 'import { $1 } from "@elizaos/core";\nimport type { $2 } from "@elizaos/core"',
    description: 'CRITICAL: Auto-split all mixed imports from @elizaos/core',
  },

  // NEW: Common value imports that should remain value imports
  {
    oldImport: 'type { Service }',
    newImport: '{ Service }',
    description: 'CRITICAL: Service is a value import, not type-only',
  },
  {
    oldImport: 'type { ModelType }',
    newImport: '{ ModelType }',
    description: 'CRITICAL: ModelType is a value import, not type-only',
  },
  {
    oldImport: 'type { logger }',
    newImport: '{ logger }',
    description: 'CRITICAL: logger is a value import, not type-only',
  },
  {
    oldImport: 'type { createUniqueUuid }',
    newImport: '{ createUniqueUuid }',
    description: 'CRITICAL: createUniqueUuid is a value import, not type-only',
  },
  {
    oldImport: 'type { MemoryType }',
    newImport: '{ MemoryType }',
    description: 'CRITICAL: MemoryType is a value import, not type-only',
  },

  // PROVIDER-SPECIFIC V1 REMOVAL PATTERNS
  {
    oldImport: 'ExternalServiceProvider',
    newImport: '',
    description: 'CRITICAL: Remove external service provider imports - use runtime services',
  },
  {
    oldImport: 'ExternalTEEMode',
    newImport: '',
    description: 'CRITICAL: Remove external TEE mode imports - use runtime services',
  },

  // PROVIDER CACHE MANAGER REPLACEMENT
  {
    oldImport: 'private cacheManager: ICacheManager',
    newImport: 'runtime: IAgentRuntime',
    description: 'CRITICAL: Replace ICacheManager with IAgentRuntime property',
  },

  // PROVIDER MULTI-CONTEXT SUPPORT
  {
    oldImport: 'async get[Resource](): Promise<[ResourceType] | null>',
    newImport: 'async get[Resources](): Promise<Record<[ContextType], [ResourceType]>>',
    description: 'CRITICAL: Replace single-context with multi-context resource methods',
  },

  // NEW: State structure related import patterns (from knowledge base)
  {
    oldImport: 'state.',
    newImport: 'state.values.',
    description:
      'CRITICAL: Replace direct state property access with state.values for simple values',
  },

  {
    oldImport: 'state.data.',
    newImport: 'state.data.',
    description: 'INFO: Keep state.data access for complex objects - already correct',
  },

  // NEW: Additional common API method changes from knowledge base
  {
    oldImport: 'runtime.updateRecentMessageState',
    newImport: '',
    description: 'CRITICAL: updateRecentMessageState removed in V2 - not needed',
  },

  {
    oldImport: 'runtime.messageManager.createMemory',
    newImport: 'runtime.createMemory',
    description: 'CRITICAL: messageManager removed - use runtime.createMemory directly',
  },

  {
    oldImport: 'runtime.memory.create',
    newImport: 'runtime.createMemory',
    description: 'CRITICAL: memory.create removed - use runtime.createMemory',
  },

  {
    oldImport: 'runtime.language.generateText',
    newImport: 'runtime.useModel',
    description: 'CRITICAL: language.generateText removed - use runtime.useModel',
  },

  // NEW: Pattern for handler signature fixes
  {
    oldImport: 'Promise<boolean>',
    newImport: '',
    description: 'CRITICAL: Remove Promise<boolean> return type from handlers in V2',
  },

  {
    oldImport: 'callback?:',
    newImport: 'callback:',
    description: 'CRITICAL: callback parameter is required in V2 handlers',
  },

  {
    oldImport: 'state?:',
    newImport: 'state:',
    description: 'CRITICAL: state parameter is required in V2 handlers',
  },

  {
    oldImport: 'options = {}',
    newImport: '_options',
    description: 'CRITICAL: Remove default value from options parameter in V2 handlers',
  },
];

/**
 * Get all import mappings
 */
export function getImportMappings(): ImportMapping[] {
  return IMPORT_MAPPINGS;
}

/**
 * Find import mapping by pattern
 */
export function findImportMapping(importText: string): ImportMapping | undefined {
  return IMPORT_MAPPINGS.find((mapping) => {
    if (typeof mapping.oldImport === 'string') {
      return importText.includes(mapping.oldImport);
    }
    return mapping.oldImport.test(importText);
  });
}

/**
 * Apply import transformation
 */
export function transformImport(importText: string, mapping: ImportMapping): string {
  if (typeof mapping.oldImport === 'string') {
    return importText.replace(mapping.oldImport, mapping.newImport as string);
  }
  return importText.replace(mapping.oldImport, mapping.newImport as string);
}
