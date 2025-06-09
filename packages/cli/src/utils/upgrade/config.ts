// Configuration constants for the migration system
export const MAX_TOKENS = 100000;
export const BRANCH_NAME = '1.x-codex';
export const CODEX_TIMEOUT = 30 * 60 * 1000; // 30 minutes
export const MIN_DISK_SPACE_GB = 2; // Minimum 2GB free space required
export const LOCK_FILE_NAME = '.elizaos-migration.lock';

// Default API key for test environments during migration
// This is used to ensure tests can run during the migration process
export const DEFAULT_OPENAI_API_KEY = '';

// Migration configuration
export const MIGRATION_CONFIG = {
  MAX_ITERATIONS: 10,
  MAX_POST_MIGRATION_ITERATIONS: 5,
  BUILD_TIMEOUT: 120000, // 2 minutes
  TEST_TIMEOUT: 300000,  // 5 minutes
  CODEX_TIMEOUT: 30 * 60 * 1000, // 30 minutes
  INSTALL_TIMEOUT: 300000, // 5 minutes
} as const;

// File patterns and directories
export const FILE_PATTERNS = {
  V1_CONFIG_FILES: [
    'biome.json',
    'vitest.config.ts',
    'vitest.config.mjs',
    'jest.config.js',
    'jest.config.ts',
    '.eslintrc.js',
    '.eslintrc.json',
    '.eslintignore',
    '.prettierrc',
    '.prettierrc.js',
    '.prettierrc.json',
    '.prettierignore',
    'environment.ts',
    'src/environment.ts',
    'environment.d.ts',
  ],
  CODE_FILES: ['src/**/*.ts', 'src/**/*.js'],
  IGNORE_PATTERNS: ['node_modules/**', 'dist/**', '.git/**'],
  TEST_DIRECTORIES: {
    V1: '__tests__',
    V2: 'src/test',
  },
} as const;

// Error patterns for better error detection
export const ERROR_PATTERNS = {
  BUILD: [
    /TS\d+:/,
    /Error: /,
    /Cannot find module/,
    /Module not found/,
  ],
  TEST: [
    /FAIL/,
    /Test failed/,
    /AssertionError/,
    /Expected.*received/,
  ],
  LINT: [
    /prettier/,
    /format/,
    /Parsing error/,
  ],
  ZOD: [
    /Expected .*, received/,
    /invalid_type/,
    /ZodError/,
  ],
  ENV: [
    /Missing required environment variable/,
    /Environment variable .* is required/,
    /is not defined/,
  ],
} as const;

// Dependencies for V2 plugins
export const V2_DEPENDENCIES = {
  CORE: '@elizaos/core',
  ZOD: 'zod',
  VERSION: {
    CORE: '^1.0.0',
    ZOD: '3.24.2',
  },
} as const;

export const V2_DEV_DEPENDENCIES = {
  PRETTIER: 'prettier',
  TSUP: 'tsup',
  VERSION: {
    PRETTIER: '3.5.3',
    TSUP: '8.4.0',
  },
} as const;

// Scripts for V2 plugins
export const V2_SCRIPTS = {
  build: 'tsup',
  dev: 'tsup --watch',
  test: 'elizaos test',
  lint: 'prettier --write ./src',
  format: 'prettier --write ./src',
  'format:check': 'prettier --check ./src',
  clean: 'rm -rf dist .turbo node_modules .turbo-tsconfig.json tsconfig.tsbuildinfo',
} as const;

// Environment variable patterns
export const ENV_VAR_PATTERNS = {
  API_KEY: /([A-Z_]+_API_KEY)/g,
  TOKEN: /([A-Z_]+_TOKEN)/g,
  SECRET: /([A-Z_]+_SECRET)/g,
  ENDPOINT: /([A-Z_]+_ENDPOINT)/g,
  URL: /([A-Z_]+_URL)/g,
  SETTINGS: /runtime\.getSetting\(["']([^"']+)["']\)/g,
  PROCESS_ENV: /process\.env\.([A-Z_]+)/g,
} as const;

// Validation functions
export function validateMigrationConfig() {
  const required = ['OPENAI_API_KEY'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

export function getTimeoutForOperation(operation: 'build' | 'test' | 'install' | 'codex'): number {
  switch (operation) {
    case 'build': return MIGRATION_CONFIG.BUILD_TIMEOUT;
    case 'test': return MIGRATION_CONFIG.TEST_TIMEOUT;
    case 'install': return MIGRATION_CONFIG.INSTALL_TIMEOUT;
    case 'codex': return MIGRATION_CONFIG.CODEX_TIMEOUT;
    default: return 120000; // 2 minutes default
  }
}


