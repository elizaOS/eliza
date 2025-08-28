#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-sql using standardized build utilities
 */

import { createBuildRunner } from '../../build-utils';

// Create and run the standardized build runner
const run = createBuildRunner({
  packageName: '@elizaos/plugin-sql',
  buildOptions: {
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'node',
    format: 'esm',
    external: [
      'dotenv',
      '@reflink/reflink',
      '@node-llama-cpp',
      'agentkeepalive',
      'uuid',
      '@elizaos/core',
      '@electric-sql/pglite',
      'zod',
      'fs',
      'path',
      'postgres',
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
