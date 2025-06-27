/**
 * Standard configuration exports for ElizaOS packages
 * Provides centralized access to all base configurations
 */

// TypeScript configurations
export { default as tsConfigBase } from './typescript/tsconfig.base.json';
export { default as tsConfigPlugin } from './typescript/tsconfig.plugin.json';
export { default as tsConfigFrontend } from './typescript/tsconfig.frontend.json';
export { default as tsConfigTest } from './typescript/tsconfig.test.json';

// Build configurations
export { buildConfig as pluginBuildConfig } from './build/build.config.plugin';

// ESLint configurations
export { default as eslintConfigPlugin } from './eslint/eslint.config.plugin.js';
export { default as eslintConfigFrontend } from './eslint/eslint.config.frontend.js';
export { baseConfig as eslintBaseConfig, testOverrides, standardIgnores } from './eslint/eslint.config.base.js';

// Prettier configuration
export { default as prettierConfig } from './prettier/prettier.config.js';

// Configuration paths for package.json references
export const configPaths = {
  typescript: {
    base: '@elizaos/core/configs/typescript/tsconfig.base.json',
    plugin: '@elizaos/core/configs/typescript/tsconfig.plugin.json',
    frontend: '@elizaos/core/configs/typescript/tsconfig.frontend.json',
    test: '@elizaos/core/configs/typescript/tsconfig.test.json',
  },
  build: {
    plugin: '@elizaos/core/configs/build/build.config.plugin.ts',
    script: '@elizaos/core/configs/build/build.plugin.ts',
  },
  eslint: {
    plugin: '@elizaos/core/configs/eslint/eslint.config.plugin.js',
    frontend: '@elizaos/core/configs/eslint/eslint.config.frontend.js',
  },
  prettier: '@elizaos/core/configs/prettier/prettier.config.js',
};