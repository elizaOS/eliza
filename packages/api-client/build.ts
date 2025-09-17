#!/usr/bin/env bun
/**
 * Build script for @elizaos/api-client using standardized build utilities
 */

import { createBuildRunner } from '../../build-utils';

// Create and run the standardized build runner
const run = createBuildRunner({
  packageName: '@elizaos/api-client',
  buildOptions: {
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'node',
    format: 'esm',
    external: ['@elizaos/core', 'fs', 'path'],
    sourcemap: true,
    minify: false,
    generateDts: true,
  },
  onBuildComplete: async (success) => {
    if (success) {
      // Create root index.d.ts that re-exports from the nested structure
      const rootDtsContent = `export * from './api-client/src/index';`;
      await Bun.write('./dist/index.d.ts', rootDtsContent);
      console.log('✓ Created root index.d.ts');
    }
  },
});

// Execute the build
run().catch((error) => {
  console.error('Build script error:', error);
  process.exit(1);
});
