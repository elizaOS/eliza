import prettierConfig from '../core/configs/prettier/prettier.config.js';

/**
 * Prettier configuration for @elizaos/plugin-sql
 * Uses the standardized configuration from core/configs
 */
export default {
  ...prettierConfig,
  // SQL plugin uses standard formatting
};