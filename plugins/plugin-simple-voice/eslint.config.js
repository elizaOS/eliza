import pluginConfig from '../../eslint.config.js';

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
      // Sam plugin specific overrides
      '@typescript-eslint/no-explicit-any': 'off', // Aligned with project-wide settings
      'no-console': 'off', // Allow console for development
    },
  },
];
