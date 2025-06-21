/**
 * TEST GENERATION MODULE - MAIN ENTRY POINT
 * 
 * Responsibilities:
 * - Export all test generation components
 * - Provide unified interface for test generation
 * - Maintain backward compatibility with existing code
 */

export { PluginAnalyzer } from './plugin-analyzer.js';
export { TemplateGenerator } from './template-generator.js';
export { TestValidator } from './test-validator.js';

// Re-export types for convenience
export type {
  PluginAnalysis,
  TestTemplateVariables,
  TestGenerationResult
} from './types.js'; 