import rootConfig from '../../eslint.config.js';

// Only add our custom rules for non-test source files
export default [
  ...rootConfig,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/__tests__/**/*'],
    rules: {
      // Allow unused vars in catch blocks for this package
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '.*', // This allows any unused error variables in catch blocks
        },
      ],

      // Custom indent rules for complex ternary operators
      indent: [
        'error',
        2,
        {
          SwitchCase: 1,
          flatTernaryExpressions: true,
          offsetTernaryExpressions: true,
        },
      ],
    },
  },
];
