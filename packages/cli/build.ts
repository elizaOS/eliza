#!/usr/bin/env bun
/**
 * Build script for @elizaos/cli using standardized build utilities
 */

import { createBuildRunner, copyAssets } from '../../build-utils';
import { $ } from 'bun';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';

// Custom pre-build step to copy templates and generate version
async function preBuild() {
  // Generate version file first
  console.log('\nGenerating version file...');
  let start = performance.now();
  await $`bun run src/scripts/generate-version.ts`;
  let elapsed = ((performance.now() - start) / 1000).toFixed(2);
  console.log(`✓ Version file generated (${elapsed}s)`);

  // Copy templates
  console.log('\nCopying templates...');
  start = performance.now();
  await $`bun run src/scripts/copy-templates.ts`;
  elapsed = ((performance.now() - start) / 1000).toFixed(2);
  console.log(`✓ Templates copied (${elapsed}s)`);
}

// Create and run the standardized build runner
const run = createBuildRunner({
  packageName: '@elizaos/cli',
  buildOptions: {
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
    // Assets will be copied after build via onBuildComplete
  },
  onBuildComplete: async (success) => {
    if (success) {
      // Copy templates and migration guides to dist
      console.log('\nCopying assets...');
      await copyAssets([
        { from: './templates', to: './dist/templates' },
        // Migration guides are embedded in the CLI code itself, no need to copy external files
      ]);
      
      // Ensure the version file is properly copied to dist
      const versionSrcPath = './src/version.ts';
      const versionDistPath = './dist/version.js';
      if (existsSync(versionSrcPath)) {
        // Read the TypeScript version file
        const versionContent = await fs.readFile(versionSrcPath, 'utf-8');
        // Convert to JavaScript by removing TypeScript-specific syntax
        const jsContent = versionContent
          .replace(/export const (\w+): string = /g, 'export const $1 = ')
          .replace(/export default {/, 'export default {');
        await fs.writeFile(versionDistPath, jsContent);
        console.log('✓ Version file copied to dist/version.js');
      } else {
        console.warn('⚠️  Version file not found at src/version.ts - generating fallback');
        // Generate a fallback version file if the source doesn't exist
        const fallbackContent = `export const CLI_VERSION = '0.0.0';
export const CLI_NAME = '@elizaos/cli';
export const CLI_DESCRIPTION = 'elizaOS CLI';
export default { version: '0.0.0', name: '@elizaos/cli', description: 'elizaOS CLI' };`;
        await fs.writeFile(versionDistPath, fallbackContent);
      }
    }
  },
});

// Execute the build with pre-build step
async function buildWithPreStep() {
  await preBuild();
  await run();
}

buildWithPreStep().catch((error) => {
  console.error('Build script error:', error);
  process.exit(1);
});
