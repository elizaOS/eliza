/**
 * TEST TEMPLATES MAIN EXPORTS
 * 
 * Responsibilities:
 * - Export all test template constants
 * - Export utility functions
 * - Provide clean interface for template usage
 */

// Export utils template
export { UTILS_TS_EXACT_CONTENT } from './utils-template';

// Export test template and utilities
export {
    TEST_TS_TEMPLATE,
    getTestTemplateVariables,
    type TestTemplateVariables,
} from './test-template';

// Re-export for backward compatibility
export * from './utils-template';
export * from './test-template'; 