/**
 * Node.js-specific entry point for @elizaos/core
 *
 * This file exports all modules including Node.js-specific functionality.
 * This is the full API surface of the core package.
 */

// Export everything from types
export * from './types';

// Export utils first to avoid circular dependency issues
export * from './utils';

// Export schemas
export * from './schemas/character';

// Export browser-compatible utilities
export * from './utils/environment';
export * from './utils/buffer';
// Export Node-specific utilities
export * from './utils/node';

// Export all core modules
export * from './actions';
export * from './database';
export * from './entities';
export * from './logger';
export * from './prompts';
export * from './roles';
export * from './runtime';
export * from './settings';
export * from './services';
export * from './search';
export * from './elizaos';

// Node-specific exports
export const isBrowser = false;
export const isNode = true;
