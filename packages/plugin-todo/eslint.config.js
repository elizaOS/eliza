import pluginConfig from '../core/configs/eslint/eslint.config.plugin.js';

/**
 * ESLint configuration for @elizaos/plugin-todo
 * Uses the standardized plugin configuration from core/configs
 * 
 * This is a todo management plugin with React frontend components.
 */
export default [
  ...pluginConfig,
  {
    // Todo plugin specific overrides
    files: ['**/*.{js,jsx,ts,tsx}'],
    rules: {
      // Allow flexibility for todo data structures
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off', // Allow console for todo operations
    },
  },
];