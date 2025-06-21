/**
 * MIGRATION STEPS MAIN EXPORTS
 * 
 * Responsibilities:
 * - Export all migration step handler classes
 * - Provide clean interface for migration orchestration
 * - Main entry point for step-based migration
 */

// Export main step executor
export { MigrationStepExecutor } from './step-executor.js';

// Export specialized step handlers
export { FileStructureSteps } from './file-structure.js';
export { ConfigurationSteps } from './configuration.js';
export { TestingSteps } from './testing.js';
export { DocumentationSteps } from './documentation.js';

// Re-export for backward compatibility
export * from './step-executor.js';
export * from './file-structure.js';
export * from './configuration.js';
export * from './testing.js';
export * from './documentation.js'; 