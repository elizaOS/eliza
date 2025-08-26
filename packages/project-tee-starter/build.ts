#!/usr/bin/env bun
/**
 * Build script for @elizaos/project-tee-starter using standardized build utilities
 */

import { createBuildRunner } from '@elizaos/utils';

// Create and run the standardized build runner
const run = createBuildRunner({
  packageName: '@elizaos/project-tee-starter',
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
      '@elizaos/plugin-bootstrap',
      '@elizaos/plugin-sql',
      'zod',
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