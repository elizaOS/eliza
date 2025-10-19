/**
 * Main entry point for @elizaos/core
 *
 * This is the default export that includes all modules.
 * The build system creates separate bundles for Node.js and browser environments.
 * Package.json conditional exports handle the routing to the correct build.
 */

// Export everything from types
export * from './types';

// Export utils first to avoid circular dependency issues
export * from './utils';

// Export schemas
export * from './schemas/character';

// Export character utilities
export * from './character';

// Export environment utilities
export * from './utils/environment';

// Export buffer utilities
export * from './utils/buffer';

// Export path utilities - these are Node.js specific but needed for backward compatibility
// Browser builds will handle this through conditional exports in package.json
export * from './utils/paths';

// Then all other exports
export * from './actions';
export * from './database';
export * from './entities';
export * from './logger';
export * from './memory';
export * from './prompts';
export * from './roles';
export * from './runtime';
export * from './secrets';
export * from './settings';
export * from './services';
export * from './services/message-service';
export * from './services/default-message-service';
export * from './search';

// Export ElizaOS
export * from './elizaos';

// Environment detection utilities
export const isBrowser =
  typeof globalThis !== 'undefined' &&
  typeof (globalThis as any).window !== 'undefined' &&
  typeof (globalThis as any).document !== 'undefined';
export const isNode =
  typeof process !== 'undefined' &&
  typeof process.versions !== 'undefined' &&
  typeof process.versions.node !== 'undefined';

// Re-export server health with a conditional stub for browser environments
export * from './utils/server-health';
