#!/usr/bin/env bun
/**
 * Self-contained build script for ElizaOS projects
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { $ } from 'bun';

async function cleanBuild(outdir = 'dist') {
  if (existsSync(outdir)) {
    await rm(outdir, { recursive: true, force: true });
    console.log(`✓ Cleaned ${outdir} directory`);
  }
}

async function build() {
  const start = performance.now();
  console.log('🚀 Building project...\n');

  try {
    // Clean previous build
    await cleanBuild('dist');

    // Build with Bun
    console.log('Bundling with Bun...');
    const result = await Bun.build({
      entrypoints: ['./src/index.ts'],
      outdir: './dist',
      target: 'node',
      format: 'esm',
      sourcemap: true,
      minify: false,
      external: [
        'dotenv',
        'fs',
        'path',
        'https',
        'node:*',
        '@elizaos/core',
        '@elizaos/plugin-bootstrap',
        '@elizaos/plugin-sql',
        '@elizaos/cli',
        'zod',
      ],
      naming: {
        entry: '[dir]/[name].[ext]',
      },
    });

    if (!result.success) {
      console.error('✗ Build failed:', result.logs);
      return false;
    }

    const totalSize = result.outputs.reduce((sum, output) => sum + output.size, 0);
    const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
    console.log(`✓ Built ${result.outputs.length} file(s) - ${sizeMB}MB`);

    // Generate TypeScript declarations
    console.log('\nGenerating TypeScript declarations...');
    try {
      await $`tsc --emitDeclarationOnly --incremental --project ./tsconfig.build.json`.quiet();
      console.log('✓ TypeScript declarations generated');
    } catch (error) {
      console.warn('⚠ Failed to generate TypeScript declarations');
      console.warn('  This is usually due to test files or type errors.');
    }

    const elapsed = ((performance.now() - start) / 1000).toFixed(2);
    console.log(`\n✅ Build complete! (${elapsed}s)\n`);
    return true;
  } catch (error) {
    console.error('Build error:', error);
    return false;
  }
}

// Execute the build
build()
  .then((success) => {
    if (!success) {
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error('Build script error:', error);
    process.exit(1);
  });
