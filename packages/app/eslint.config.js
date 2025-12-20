import pluginConfig from '@elizaos/config/eslint/eslint.config.plugin.js';

export default [
  ...pluginConfig,
  {
    rules: {
      // Disable indent rule - Prettier handles indentation
      // The indent rule causes stack overflow with complex JSX/TSX
      indent: 'off',
    },
  },
];
