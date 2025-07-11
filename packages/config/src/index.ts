/**
 * Standard configuration exports for ElizaOS packages
 * Provides centralized access to all base configurations
 */

// TypeScript configurations
export { default as tsConfigBase } from './typescript/tsconfig.base.json';
export { default as tsConfigPlugin } from './typescript/tsconfig.plugin.json';
export { default as tsConfigFrontend } from './typescript/tsconfig.frontend.json';
export { default as tsConfigTest } from './typescript/tsconfig.test.json';

// ESLint configurations
export { default as eslintConfigPlugin } from './eslint/eslint.config.plugin.js';
export { default as eslintConfigFrontend } from './eslint/eslint.config.frontend.js';
export {
  baseConfig as eslintBaseConfig,
  testOverrides,
  standardIgnores,
} from './eslint/eslint.config.base.js';

// Prettier configuration
export { default as prettierConfig } from './prettier/prettier.config.js';

// Configuration paths for package.json references
export const configPaths = {
  typescript: {
    base: '@elizaos/configs/typescript/tsconfig.base.json',
    plugin: '@elizaos/configs/typescript/tsconfig.plugin.json',
    frontend: '@elizaos/configs/typescript/tsconfig.frontend.json',
    test: '@elizaos/configs/typescript/tsconfig.test.json',
  },
  build: {
    plugin: '@elizaos/configs/build/build.config.plugin.ts',
    script: '@elizaos/configs/build/build.plugin.ts',
  },
  eslint: {
    plugin: '@elizaos/configs/eslint/eslint.config.plugin.js',
    frontend: '@elizaos/configs/eslint/eslint.config.frontend.js',
  },
  prettier: '@elizaos/configs/prettier/prettier.config.js',
};
