import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierPlugin from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default [
  // Base ESLint recommended config
  eslint.configs.recommended,
  
  // Prettier config to disable conflicting rules
  prettierConfig,
  
  {
    // Files to lint
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    
    // Language options
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.eslint.json',
      },
      globals: {
        ...globals.node,
        ...globals.es2022,
        ...globals.jest,
        // Additional globals for TypeScript and browser APIs
        NodeJS: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        config: 'readonly',
      },
    },
    
    // Plugins
    plugins: {
      '@typescript-eslint': tseslint,
      prettier: prettierPlugin,
    },
    
    // Rules
    rules: {
      // TypeScript ESLint recommended rules
      ...tseslint.configs.recommended.rules,
      
      // Prettier
      'prettier/prettier': 'error',
      
      // TypeScript specific rules
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/prefer-as-const': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off', // New name for no-var-requires in v8
      
      // JavaScript rules
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      'eqeqeq': 'off',
      'curly': ['error', 'all'],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-case-declarations': 'off',
      'no-useless-escape': 'off',
      'no-undef': 'error', // Keep this enabled but with proper globals
      'no-prototype-builtins': 'off', // Allow hasOwnProperty
      'no-duplicate-case': 'off', // Disable duplicate case check
    },
  },
  
  // Ignore patterns
  {
    ignores: [
      'dist/',
      'node_modules/',
      'coverage/',
      '*.js',
      '*.d.ts',
      'tools-js/',
      'tools/',
      'trajectories/',
      // Also ignore the ESLint config itself
      'eslint.config.mjs',
    ],
  },
];
