/**
 * MIGRATION PATTERNS MODULE - MAIN ENTRY POINT
 * 
 * Responsibilities:
 * - Export all migration pattern components
 * - Provide unified interface for accessing migration patterns
 * - Maintain backward compatibility with original mega-prompt-parser
 * - Centralized access to all pattern matching and transformation logic
 */

// Import functions for use in utility functions
import { getImportMappings } from './import-mappings.js';
import { getModelTypeMappings, needsModelTransformation } from './model-mappings.js';
import { getArchitectureIssues, getIssuesBySeverity, checkForArchitectureIssues } from './architecture-patterns.js';
import { getTestingPatterns, checkForTestingIssues, getCriticalTestingIssues } from './testing-patterns.js';
import { parseIntoChunks, getPromptChunksByPhase, generatePhasePrompt } from './prompt-parser.js';
import type { MigrationPhase } from '../types.js';

// Export all pattern data
export { IMPORT_MAPPINGS, getImportMappings, findImportMapping, transformImport } from './import-mappings.js';
export { MODEL_TYPE_MAPPINGS, getModelTypeMappings, findModelMapping, transformModelCode, getModelMappingsByCategory, needsModelTransformation } from './model-mappings.js';
export { ARCHITECTURE_ISSUES, getArchitectureIssues, findArchitectureIssue, getIssuesBySeverity, getIssuesByCategory, checkForArchitectureIssues } from './architecture-patterns.js';

// Export testing patterns (with type issues, but functionality preserved)
export { 
  TESTING_PATTERNS, 
  getTestingPatterns, 
  findTestingPattern, 
  getTestingPatternsBySeverity, 
  getTestingPatternsByCategory,
  checkForTestingIssues,
  getCriticalTestingIssues 
} from './testing-patterns.js';

// Export prompt parsing functionality
export { 
  parseIntoChunks, 
  getPromptChunkById, 
  getPromptChunksByPhase, 
  getMigrationPhases,
  formatPromptChunk,
  generateComprehensiveMigrationPrompt,
  generatePhasePrompt
} from './prompt-parser.js';

// Re-export types for convenience
export type { ImportMapping, ModelTypeMapping, ArchitectureIssue, PromptChunk, MigrationPhase } from '../types.js';

/**
 * Get all migration patterns organized by category
 */
export function getAllMigrationPatterns() {
  return {
    imports: getImportMappings(),
    models: getModelTypeMappings(),
    architecture: getArchitectureIssues(),
    testing: getTestingPatterns(),
    prompts: parseIntoChunks(),
  };
}

/**
 * Get all critical migration issues that must be addressed
 */
export function getCriticalMigrationIssues() {
  return {
    architecture: getIssuesBySeverity('critical'),
    testing: getCriticalTestingIssues(),
  };
}

/**
 * Check code for all types of migration issues
 */
export function checkCodeForAllIssues(code: string) {
  return {
    architectureIssues: checkForArchitectureIssues(code),
    testingIssues: checkForTestingIssues(code),
    needsModelTransformation: needsModelTransformation(code),
  };
}

/**
 * Get migration guidance for a specific phase
 */
export function getMigrationGuidanceForPhase(phase: MigrationPhase) {
  return {
    prompt: generatePhasePrompt(phase),
    chunks: getPromptChunksByPhase(phase),
    criticalIssues: getCriticalMigrationIssues(),
  };
} 