/**
 * CLAUDE SDK INTEGRATION
 * 
 * Responsibilities:
 * - Export SDK adapter and utilities
 * - Export metrics and session management
 * - Provide clean interface for SDK operations
 */

// Export SDK utilities
export {
    importClaudeSDK,
    isClaudeSDKAvailable,
    validateClaudeSDKEnvironment,
    getSDKErrorContext,
    type SDKMessage,
    type ClaudeQueryOptions,
    type ClaudeQueryParams,
    type ClaudeSDKModule,
} from './utils';

// Export SDK adapter and session management
export {
    EnhancedClaudeSDKAdapter,
    createMigrationMetricsCollector,
    createSessionManager,
} from './adapter';

// Re-export for backward compatibility
export * from './utils';
export * from './adapter'; 