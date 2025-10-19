/**
 * Browser-specific entry point for @elizaos/core
 *
 * This file exports only browser-compatible modules and provides
 * stubs or alternatives for Node.js-specific functionality.
 */

// Export everything from types (type-only, safe for browser)
export * from './types';

// Export utils first to avoid circular dependency issues
export * from './utils';

// Export schemas
export * from './schemas/character';

// Export browser-compatible utilities
export * from './utils/environment';
export * from './utils/buffer';
// Note: Excluding server-health and paths as they're Node-specific

// Export core modules (all browser-compatible after refactoring)
export * from './actions';
export * from './database';
export * from './entities';
export * from './logger';
export * from './memory';
export * from './prompts';
export * from './roles';
export * from './runtime';
export * from './settings';
export * from './services';
export * from './services/message-service';
export * from './services/default-message-service';
export * from './search';
export * from './elizaos';

// Browser-specific exports or stubs for Node-only features
export const isBrowser = true;
export const isNode = false;

/**
 * Browser stub for server health checks
 * In browser environment, this is a no-op
 */
export const serverHealth = {
  check: async () => ({ status: 'not-applicable', environment: 'browser' }),
  isHealthy: () => true,
};
