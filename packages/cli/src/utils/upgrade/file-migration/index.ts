/**
 * FILE MIGRATION MAIN EXPORTS
 * 
 * Responsibilities:
 * - Export all file migration components
 * - Provide clean interface for file migration
 * - Main entry point for file-by-file migration
 */

// Export main migrator class
export { FileByFileMigrator } from './core-migrator.js';

// Export utility classes
export { FileHandlers } from './file-handlers.js';
export { CleanupUtils } from './cleanup-utils.js';
export { PatternDetection } from './pattern-detection.js';

// Export types and interfaces
export type { V1Pattern, PatternDetectionResult } from './pattern-detection.js';

// Re-export for backward compatibility
export * from './core-migrator.js';
export * from './file-handlers.js';
export * from './cleanup-utils.js';
export * from './pattern-detection.js'; 