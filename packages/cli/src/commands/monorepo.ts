// Re-export the modular monorepo command for backward compatibility
export { monorepo } from './monorepo/index';

// Export all modular components for direct access
export * from './monorepo/actions/clone';
export * from './monorepo/types';
export * from './monorepo/utils/setup-instructions';
