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
  console.log('\nPre-build tasks...');
  const start = performance.now();

  // Run both pre-build tasks in parallel
  const [versionResult, templateResult] = await Promise.all([
    $`bun run src/scripts/generate-version.ts`
      .then(() => {
        const taskTime = ((performance.now() - start) / 1000).toFixed(2);
        console.log(`  ✓ Version file generated (${taskTime}s)`);
        return true;
      })
      .catch((err) => {
        console.error('  ✗ Version generation failed:', err);
        throw err;
      }),
    $`bun run src/scripts/copy-templates.ts`
      .then(() => {
        const taskTime = ((performance.now() - start) / 1000).toFixed(2);
        console.log(`  ✓ Templates copied (${taskTime}s)`);
        return true;
      })
      .catch((err) => {
        console.error('  ✗ Template copying failed:', err);
        throw err;
      }),
  ]);

  const elapsed = ((performance.now() - start) / 1000).toFixed(2);
  console.log(`✅ Pre-build tasks completed (${elapsed}s)`);
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
      console.log('\nPost-build tasks...');
      const postBuildStart = performance.now();

      // Prepare all post-build tasks
      const postBuildTasks: Promise<void>[] = [];

      // Task 1: Copy templates
      postBuildTasks.push(
        copyAssets([{ from: './templates', to: './dist/templates' }])
          .then(() => console.log('  ✓ Templates copied to dist'))
          .catch((err) => {
            console.error('  ✗ Template copying failed:', err);
            throw err;
          })
      );

      // Task 2: Handle version file
      const versionSrcPath = './src/version.ts';
      const versionDistPath = './dist/version.js';
      postBuildTasks.push(
        (async () => {
          if (existsSync(versionSrcPath)) {
            // Read the TypeScript version file
            const versionContent = await fs.readFile(versionSrcPath, 'utf-8');
            // Convert to JavaScript by removing TypeScript-specific syntax
            const jsContent = versionContent
              .replace(/export const (\w+): string = /g, 'export const $1 = ')
              .replace(/export default {/, 'export default {');
            await fs.writeFile(versionDistPath, jsContent);
            console.log('  ✓ Version file copied to dist/version.js');
          } else {
            console.warn('  ⚠️  Version file not found at src/version.ts - generating fallback');
            // Generate a fallback version file if the source doesn't exist
            const fallbackContent = `export const CLI_VERSION = '0.0.0';
export const CLI_NAME = '@elizaos/cli';
export const CLI_DESCRIPTION = 'elizaOS CLI';
export default { version: '0.0.0', name: '@elizaos/cli', description: 'elizaOS CLI' };`;
            await fs.writeFile(versionDistPath, fallbackContent);
          }
        })()
      );

      // Execute all post-build tasks in parallel
      await Promise.all(postBuildTasks);

      const postBuildElapsed = ((performance.now() - postBuildStart) / 1000).toFixed(2);
      console.log(`✅ Post-build tasks completed (${postBuildElapsed}s)`);
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
