#!/usr/bin/env bun
/**
 * Build script for @elizaos/server using standardized build utilities
 */

import { createBuildRunner, copyAssets } from '../../build-utils';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Create and run the standardized build runner
const run = createBuildRunner({
  packageName: '@elizaos/server',
  buildOptions: {
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'node',
    format: 'esm',
    external: [
      '@elizaos/core',
      '@elizaos/client',
      'express',
      'cors',
      'multer',
      'swagger-ui-express',
      '@elizaos/plugin-sql',
      'lancedb',
      'vectordb',
      'socket.io',
      'discord.js',
    ],
    sourcemap: false,
    minify: false,
    generateDts: true,
  },
  onBuildComplete: async (success) => {
    if (success) {
      // Check if client assets exist and copy them
      const clientDistPath = join(process.cwd(), '../client/dist');
      if (existsSync(clientDistPath)) {
        console.log('\nCopying client assets...');
        await copyAssets([{ from: clientDistPath, to: './dist/client' }]);
      }

      // Copy any static assets
      if (existsSync('./public')) {
        console.log('\nCopying static assets...');
        await copyAssets([{ from: './public', to: './dist/public' }]);
      }
    }
  },
});

// Execute the build
run().catch((error) => {
  console.error('Build script error:', error);
  process.exit(1);
});