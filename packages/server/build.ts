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
      // Prepare asset copy tasks
      const copyTasks: Promise<void>[] = [];
      const clientDistPath = join(process.cwd(), '../client/dist');
      
      // Check if client assets exist and add to copy tasks
      if (existsSync(clientDistPath)) {
        console.log('\nCopying client assets...');
        copyTasks.push(
          copyAssets([{ from: clientDistPath, to: './dist/client' }])
            .then(() => console.log('✓ Client assets copied'))
        );
      }

      // Check if static assets exist and add to copy tasks
      if (existsSync('./public')) {
        console.log('Copying static assets...');
        copyTasks.push(
          copyAssets([{ from: './public', to: './dist/public' }])
            .then(() => console.log('✓ Static assets copied'))
        );
      }

      // Copy all assets in parallel
      if (copyTasks.length > 0) {
        const copyStart = performance.now();
        await Promise.all(copyTasks);
        const copyDuration = ((performance.now() - copyStart) / 1000).toFixed(2);
        console.log(`✅ All assets copied in parallel (${copyDuration}s)`);
      }
    }
  },
});

// Execute the build
run().catch((error) => {
  console.error('Build script error:', error);
  process.exit(1);
});
