#!/usr/bin/env bun
/**
 * Build script for @elizaos/server using Bun.build
 */

import { createElizaBuildConfig, generateDts, cleanBuild, copyAssets, getTimer } from '../../build-utils';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

async function build() {
  const totalTimer = getTimer();
  console.log('🚀 Building @elizaos/server...\n');
  
  // Clean previous build
  await cleanBuild('dist');
  
  // Build server code
  const configTimer = getTimer();
  const config = await createElizaBuildConfig({
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
  });
  console.log(`✓ Configuration prepared (${configTimer.elapsed()}ms)`);

  // Build with Bun
  console.log('\nBundling with Bun...');
  const buildTimer = getTimer();
  const result = await Bun.build(config);
  
  if (!result.success) {
    console.error('✗ Build failed:', result.logs);
    process.exit(1);
  }
  
  const totalSize = result.outputs.reduce((sum, output) => sum + output.size, 0);
  const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
  console.log(`✓ Built ${result.outputs.length} file(s) - ${sizeMB}MB (${buildTimer.elapsed()}ms)`);
  
  // Check if client assets exist and copy them
  const clientDistPath = join(process.cwd(), '../client/dist');
  if (existsSync(clientDistPath)) {
    console.log('\nCopying client assets...');
    await copyAssets([
      { from: clientDistPath, to: './dist/client' }
    ]);
  }
  
  // Copy any static assets
  if (existsSync('./public')) {
    console.log('\nCopying static assets...');
    await copyAssets([
      { from: './public', to: './dist/public' }
    ]);
  }
  
  // Generate TypeScript declarations
  await generateDts('./tsconfig.build.json');
  
  console.log('\n✅ @elizaos/server build complete!');
  console.log(`⏱️  Total build time: ${totalTimer.elapsed()}ms\n`);
}

// Run build
build().catch(error => {
  console.error('Build error:', error);
  process.exit(1);
});