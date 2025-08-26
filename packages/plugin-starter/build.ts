#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-starter using standardized build utilities
 */

import { createBuildRunner } from '@elizaos/utils';

// Create and run the standardized build runner
const run = createBuildRunner({
  packageName: '@elizaos/plugin-starter',
  buildOptions: {
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'node',
    format: 'esm',
    external: ['dotenv', '@elizaos/core', 'zod'],
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