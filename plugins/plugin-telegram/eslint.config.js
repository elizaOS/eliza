import js from '@eslint/js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadTypeScriptEslint() {
  try {
    // Keep workspace analyzers from crashing when this plugin's local lint deps drift.
    return {
      parser: require('@typescript-eslint/parser'),
      plugin: require('@typescript-eslint/eslint-plugin'),
    };
  } catch {
    return null;
  }
}

const typeScriptEslint = loadTypeScriptEslint();

/**
 * ESLint flat config for plugin-telegram (TypeScript sources under `src/` and `__tests__/`).
 */
export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...(typeScriptEslint
    ? [
        {
          files: ['src/**/*.ts', '__tests__/**/*.ts'],
          languageOptions: {
            parser: typeScriptEslint.parser,
            parserOptions: {
              ecmaVersion: 'latest',
              sourceType: 'module',
            },
            globals: {
              Buffer: 'readonly',
              fetch: 'readonly',
              process: 'readonly',
              setTimeout: 'readonly',
            },
          },
          plugins: {
            '@typescript-eslint': typeScriptEslint.plugin,
          },
          rules: {
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': [
              'warn',
              { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
          },
        },
      ]
    : [
        {
          files: ['src/**/*.ts', '__tests__/**/*.ts'],
          languageOptions: {
            parserOptions: {
              ecmaVersion: 'latest',
              sourceType: 'module',
            },
            globals: {
              Buffer: 'readonly',
              fetch: 'readonly',
              process: 'readonly',
              setTimeout: 'readonly',
            },
          },
        },
      ]),
];
