#!/usr/bin/env bun
/**
 * Build script for @elizaos/test-utils using standardized build utilities
 */

import { createBuildRunner } from '../../build-utils';

// Create and run the standardized build runner
const run = createBuildRunner({
  packageName: '@elizaos/test-utils',
  buildOptions: {
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'node',
    format: 'esm',
    external: [
      'dotenv',
      'fs',
      'path',
      'https',
      '@elizaos/core',
      '@elizaos/plugin-sql',
      'zod',
      'vitest',
    ],
    sourcemap: true,
    minify: false,
    generateDts: true,
  },
});

// Execute the build
run().catch((error) => {
  console.error('Build script error:', error);
  process.exit(1);
});
