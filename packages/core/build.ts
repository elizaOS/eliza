#!/usr/bin/env bun
/**
 * Build script for @elizaos/core using standardized build utilities
 */

import { createBuildRunner } from '@elizaos/utils';

// Create and run the standardized build runner
const run = createBuildRunner({
  packageName: '@elizaos/core',
  buildOptions: {
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'node',
    format: 'esm',
    external: ['dotenv', 'sharp', '@solana/web3.js', 'zod', '@hapi/shot'],
    sourcemap: false,
    minify: false,
    generateDts: true,
  },
});

// Execute the build
run().catch((error) => {
  console.error('Build script error:', error);
  process.exit(1);
});