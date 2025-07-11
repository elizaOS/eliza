// Knip configuration for ElizaOS monorepo
// Simplified configuration that works in CI without type definitions

const config = {
  $schema: 'https://unpkg.com/knip@5/schema.json',

  // Entry points for the monorepo packages
  entry: [
    // Standard package entry points
    'packages/*/src/index.{ts,js,tsx,jsx}',

    // Vite app entry points
    'packages/client/src/main.tsx',
    'packages/app/src/main.tsx',

    // CLI specific entry
    'packages/cli/src/index.ts',
  ],

  // Project files to analyze
  project: [
    'packages/**/src/**/*.{ts,tsx,js,jsx}',
    '!packages/**/dist/**',
    '!packages/**/build/**',
    '!packages/**/node_modules/**',
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
    '**/.turbo/**',

    // Config files
    '**/*.config.{ts,js,mjs,cjs}',
    '**/vite.config.{ts,js,mjs}',

    // Documentation and examples
    '**/docs/**',
    '**/examples/**',
    '**/scripts/**',

    // Generated files
    '**/*.generated.{ts,js}',
    '**/generated/**',
    '**/*.d.ts',
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

    // Build tools
    'typescript',
    'vite',
    'rollup',
    'esbuild',
    'tsup',
    'turbo',

    // Testing tools
    'vitest',
    'bun:test',

    // Linters and formatters
    'eslint',
    'prettier',
    'knip',

    // Package managers
    'npm',
    'yarn',
    'pnpm',
    'bun',

    // Development tools
    'husky',
    'lerna',
  ],

  // Ignore specific binaries
  ignoreBinaries: [
    // These are called through bun/npm scripts
    'tsc',
    'tsx',
    'tsup',
    'vite',
    'rollup',
    'turbo',
    'lerna',
    'knip',
    'prettier',
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
    binaries: 'warn',

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
};

export default config;
