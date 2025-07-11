import { baseConfig, testOverrides, standardIgnores } from './eslint.config.base.js';
import frontendConfig from './eslint.config.frontend.js';

/**
 * Standard ESLint configuration for ElizaOS plugins
 * Extends the base config with plugin-specific overrides
 */
export default [
  ...baseConfig,
  ...frontendConfig,
  testOverrides,
  {
    ignores: standardIgnores,
  },
];
