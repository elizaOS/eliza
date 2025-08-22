#!/usr/bin/env bun
/**
 * Build script for @elizaos/plugin-bootstrap using Bun.build
 */

import { createElizaBuildConfig, generateDts, cleanBuild, getTimer } from '../../build-utils';

async function build() {
  const totalTimer = getTimer();
  console.log('🚀 Building @elizaos/plugin-bootstrap...\n');

  // Clean previous build
  await cleanBuild('dist');

  // Create build configuration
  const configTimer = getTimer();
  const config = await createElizaBuildConfig({
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'node',
    format: 'esm',
    external: [
      'dotenv',
      'fs',
      'path',
      '@reflink/reflink',
      'agentkeepalive',
      'zod',
      '@elizaos/core',
    ],
    sourcemap: true,
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

  // Generate TypeScript declarations
  await generateDts('./tsconfig.build.json');

  console.log('\n✅ @elizaos/plugin-bootstrap build complete!');
  console.log(`⏱️  Total build time: ${totalTimer.elapsed()}ms\n`);
}

// Run build
build().catch((error) => {
  console.error('Build error:', error);
  process.exit(1);
});
