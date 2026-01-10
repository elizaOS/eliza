import pluginConfig from '../core/configs/eslint/eslint.config.plugin.js';

/**
 * ESLint configuration for @elizaos/plugin-starter
 * Uses the standardized plugin configuration from core/configs
 *
 * This is a starter template plugin with both Node.js and React components.
 */
export default [
  ...pluginConfig,
  {
    // Plugin-starter specific overrides
    files: ['**/*.{js,jsx,ts,tsx}'],
    rules: {
      // Allow more flexibility in starter template
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      'no-console': 'off', // Allow console in template examples
    },
  },
];
