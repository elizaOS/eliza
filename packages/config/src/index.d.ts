/**
 * Standard configuration exports for ElizaOS packages
 * Provides centralized access to all base configurations
 */
export { default as tsConfigBase } from './typescript/tsconfig.base.json';
export { default as tsConfigPlugin } from './typescript/tsconfig.plugin.json';
export { default as tsConfigFrontend } from './typescript/tsconfig.frontend.json';
export { default as tsConfigTest } from './typescript/tsconfig.test.json';
export { default as eslintConfigPlugin } from './eslint/eslint.config.plugin.js';
export { default as eslintConfigFrontend } from './eslint/eslint.config.frontend.js';
export {
  baseConfig as eslintBaseConfig,
  testOverrides,
  standardIgnores,
} from './eslint/eslint.config.base.js';
export { default as prettierConfig } from './prettier/prettier.config.js';
export declare const configPaths: {
  typescript: {
    base: string;
    plugin: string;
    frontend: string;
    test: string;
  };
  eslint: {
    plugin: string;
    frontend: string;
  };
  prettier: string;
};
