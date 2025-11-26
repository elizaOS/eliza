import pluginConfig from '@elizaos/config/eslint/eslint.config.plugin.js';

/**
 * ESLint config for plugin-sql
 * Extends the shared plugin config with package-specific overrides
 */
export default [
  ...pluginConfig,
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    rules: {
      // plugin-sql specific overrides
      '@typescript-eslint/no-unused-vars': 'off',
      'no-control-regex': 'off',
    },
  },
];
