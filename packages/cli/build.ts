#!/usr/bin/env bun
/**
 * Build script for @elizaos/cli using standardized build utilities
 */

import { createBuildRunner, copyAssets } from '../../build-utils';
import { $ } from 'bun';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Read version from package.json
const packageJsonPath = path.resolve(process.cwd(), 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const cliVersion = packageJson.version;

// Custom pre-build step to copy templates
async function preBuild() {
  console.log('\nCopying templates...');
  const start = performance.now();
  await $`bun run src/scripts/copy-templates.ts`;
  const elapsed = ((performance.now() - start) / 1000).toFixed(2);
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
    // Embed CLI version as environment variable
    define: {
      'process.env.ELIZAOS_CLI_VERSION': JSON.stringify(cliVersion),
    },
    // Assets will be copied after build via onBuildComplete
  },
  onBuildComplete: async (success) => {
    if (success) {
      // Copy templates, migration guides, and package.json to dist
      console.log('\nCopying assets...');
      await copyAssets([
        { from: './templates', to: './dist/templates' },
        { from: './package.json', to: './dist/package.json' }, // Include package.json in dist
        { from: '../docs/docs/plugins/migration/claude-code', to: './dist/migration-guides' },
      ]);
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
