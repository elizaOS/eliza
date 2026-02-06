#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { watch } from 'fs';

const isWatchMode = process.argv.includes('--watch');

async function build(isInitial = false) {
  const totalStart = Date.now();
  const pkg = await Bun.file('package.json').json();
  const externalDeps = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];

  const distDir = join(process.cwd(), 'dist');
  const nodeDir = join(distDir, 'node');

  // Only clean on initial build, not on watch rebuilds
  if (isInitial) {
    if (existsSync(distDir)) {
      await $`rm -rf ${distDir}`;
    }
  }

  await mkdir(nodeDir, { recursive: true });

  console.log('Building @elizaos/plugin-form...');
  const esmResult = await Bun.build({
    entrypoints: ['src/index.ts'],
    outdir: nodeDir,
    target: 'node',
    format: 'esm',
    sourcemap: 'external',
    minify: false,
    external: externalDeps,
    naming: {
      entry: 'index.node.js',
    },
  });
  if (!esmResult.success) {
    console.error(esmResult.logs);
    throw new Error('ESM build failed');
  }
  console.log(`Build successful: ${esmResult.outputs.length} files generated`);

  // Skip type generation in watch mode for faster rebuilds
  if (!isWatchMode) {
    console.log('Generating TypeScript declarations...');
    const tscResult = await $`tsc --project tsconfig.build.json`.quiet().nothrow();
    if (tscResult.exitCode !== 0) {
      console.warn('TypeScript declaration generation had issues:');
      console.warn(tscResult.stderr.toString());
    } else {
      console.log('TypeScript declarations generated');
    }
  }

  console.log(
    `${isWatchMode ? 'Rebuild' : 'Build'} finished in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`
  );
}

if (isWatchMode) {
  console.log('Watch mode enabled - watching src/ for changes...');

  build(true).catch((err) => {
    console.error('Initial build failed:', err);
    process.exit(1);
  });

  const watcher = watch('src', { recursive: true }, async (event, filename) => {
    if (filename && filename.endsWith('.ts')) {
      console.log(`\nFile changed: ${filename}`);
      try {
        await build(false);
      } catch (err) {
        console.error('Rebuild failed:', err);
      }
    }
  });

  // Keep process alive
  process.on('SIGINT', () => {
    console.log('\nStopping watch mode...');
    watcher.close();
    process.exit(0);
  });
} else {
  build(true).catch((err) => {
    console.error('Build failed:', err);
    process.exit(1);
  });
}

