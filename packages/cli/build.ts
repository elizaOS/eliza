#!/usr/bin/env bun
/**
 * Build script for @elizaos/cli using Bun.build
 */

import {
  createElizaBuildConfig,
  copyAssets,
  generateDts,
  cleanBuild,
  getTimer,
} from '../../build-utils';
import { $ } from 'bun';

async function build() {
  const totalTimer = getTimer();
  console.log('🚀 Building @elizaos/cli...\n');

  // Clean previous build
  await cleanBuild('dist');

  // Copy templates before build
  console.log('\nCopying templates...');
  const templateTimer = getTimer();
  await $`bun run src/scripts/copy-templates.ts`;
  console.log(`✓ Templates copied (${templateTimer.elapsed()}ms)`);

  // Create build configuration
  const configTimer = getTimer();
  const config = await createElizaBuildConfig({
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'bun',
    format: 'esm',
    external: [
      'fs-extra',
      '@elizaos/server',
      '@anthropic-ai/claude-code',
      'chokidar',
      'simple-git',
      'tiktoken',
    ],
    sourcemap: true,
    minify: false,
    isCli: true,
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

  // Copy templates and migration guides to dist
  console.log('\nCopying assets...');
  await copyAssets([
    { from: './templates', to: './dist/templates' },
    { from: '../docs/docs/plugins/migration/claude-code', to: './dist/migration-guides' },
  ]);

  // Generate TypeScript declarations
  await generateDts('./tsconfig.build.json');

  console.log('\n✅ @elizaos/cli build complete!');
  console.log(`⏱️  Total build time: ${totalTimer.elapsed()}ms\n`);
}

// Run build
build().catch((error) => {
  console.error('Build error:', error);
  process.exit(1);
});
