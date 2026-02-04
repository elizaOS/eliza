/**
 * Node.js-specific entry point for @elizaos/core
 *
 * This file exports all modules including Node.js-specific functionality.
 * This is the full API surface of the core package.
 */

// Configure Node.js-specific context managers (AsyncLocalStorage)
import { setStreamingContextManager } from './streaming-context';
import { createNodeStreamingContextManager } from './streaming-context.node';
import { setRequestContextManager } from './request-context';
import { createNodeRequestContextManager } from './request-context.node';

// Initialize streaming context for automatic streaming in useModel calls
setStreamingContextManager(createNodeStreamingContextManager());

// Initialize request context for per-entity settings in multi-tenant deployments
setRequestContextManager(createNodeRequestContextManager());

// Export everything from types
export * from './types';

// Export utils first to avoid circular dependency issues
export * from './utils';

// Export schemas
export * from './schemas/character';

// Export browser-compatible utilities
export * from './utils/environment';
export * from './utils/buffer';
// Export streaming utilities
export * from './utils/streaming';
// Export Node-specific utilities
export * from './utils/node';

// Export all core modules
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
export * from './streaming-context';
export * from './request-context';

// Export configuration and plugin modules - will be removed once cli cleanup
export * from './character';
export * from './secrets';
export * from './plugin';

// Node-specific exports
export const isBrowser = false;
export const isNode = true;
