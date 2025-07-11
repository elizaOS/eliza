import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  $schema: 'https://unpkg.com/knip@5/schema.json',

  // Entry points for the monorepo packages
  entry: [
    'packages/*/src/index.{ts,js,tsx,jsx}',
    'packages/cli/src/index.ts',
    'packages/core/src/index.ts',
    'packages/client/src/index.tsx',
    'packages/app/src/main.ts',
  ],

  // Project files to analyze
  project: [
    'packages/**/src/**/*.{ts,tsx,js,jsx}',
    '!packages/**/dist/**',
    '!packages/**/node_modules/**',
    '!packages/**/*.d.ts',
  ],

  // Ignore patterns
  ignore: [
    // Test files
    '**/*.test.{ts,tsx,js,jsx}',
    '**/*.spec.{ts,tsx,js,jsx}',
    '**/__tests__/**',
    '**/test/**',
    '**/tests/**',

    // Build outputs
    '**/dist/**',
    '**/build/**',
    '**/out/**',

    // Config files that may have unused exports
    '**/*.config.{ts,js}',
    '**/vite.config.ts',
    '**/rollup.config.js',

    // Documentation and examples
    '**/docs/**',
    '**/examples/**',

    // Generated files
    '**/*.generated.ts',
    '**/generated/**',
  ],

  // Workspace configuration for monorepo
  workspaces: {
    'packages/*': {
      entry: ['src/index.{ts,js,tsx,jsx}'],
      project: ['src/**/*.{ts,tsx,js,jsx}'],
    },
  },

  // Ignore exports used in the same file
  ignoreExportsUsedInFile: true,

  // Ignore specific dependencies
  ignoreDependencies: [
    // Type definitions
    '@types/*',

    // Build tools that are used in config files
    'typescript',
    'vite',
    'rollup',
    'esbuild',
    'tsup',

    // Testing tools used in test files
    'vitest',
    'bun:test',

    // ElizaOS uses bun, but some deps might reference these
    'npm',
    'yarn',
    'pnpm',
  ],

  // Ignore specific binaries
  ignoreBinaries: [
    // These are called through bun/npm scripts
    'tsc',
    'tsx',
    'tsup',
    'vite',
  ],

  // Rules configuration
  rules: {
    // Report unused files
    files: 'error',

    // Report unused dependencies
    dependencies: 'error',
    devDependencies: 'error',
    optionalPeerDependencies: 'warn',

    // Report unlisted dependencies
    unlisted: 'error',

    // Report unused binaries
    binaries: 'error',

    // Report unresolved imports
    unresolved: 'error',

    // Report unused exports
    exports: 'error',

    // Report unused types
    types: 'error',

    // Report unused namespace exports
    nsExports: 'error',

    // Report duplicate exports
    duplicates: 'error',

    // Report unused enum members
    enumMembers: 'warn',

    // Report unused class members
    classMembers: 'warn',
  },

  // Compilers to use for different file types
  compilers: {
    css: 'node_modules/.bin/postcss',
    svg: 'node_modules/.bin/svgo',
  },

  // Plugins to include in analysis
  plugins: [
    // Include plugin files in analysis
    'packages/plugin-*/src/**/*.{ts,js}',
  ],

  // Additional include patterns for specific file types
  include: {
    // Include GitHub Actions workflows
    gitHubActions: ['.github/workflows/*.yml'],
  },

  // Exclude patterns for specific file types
  exclude: {
    // Exclude test files from production analysis
    production: [
      '**/*.test.*',
      '**/*.spec.*',
      '**/__tests__/**',
      '**/test/**',
      '**/tests/**',
    ],
  },

  // Reporter configuration
  reporter: 'symbols',

  // Issue types to report
  issueTypes: [
    'files',
    'dependencies',
    'devDependencies',
    'unlisted',
    'binaries',
    'unresolved',
    'exports',
    'types',
    'nsExports',
    'duplicates',
    'enumMembers',
    'classMembers',
  ],
};

export default config;
