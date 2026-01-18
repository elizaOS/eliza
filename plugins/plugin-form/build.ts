#!/usr/bin/env bun
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

  // Only clean on initial build, not on watch rebuilds
  if (isInitial && pkg.scripts?.clean) {
    console.log('🧹 Cleaning...');
    await $`bun run clean`.quiet();
  }

  const esmStart = Date.now();
  console.log('🔨 Building @elizaos/plugin-form...');
  const esmResult = await Bun.build({
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'node',
    format: 'esm',
    sourcemap: 'external',
    minify: false,
    external: externalDeps,
  });
  if (!esmResult.success) {
    console.error(esmResult.logs);
    throw new Error('ESM build failed');
  }
  console.log(`✅ Build complete in ${((Date.now() - esmStart) / 1000).toFixed(2)}s`);

  // Skip type generation in watch mode for faster rebuilds
  if (!isWatchMode) {
    const dtsStart = Date.now();
    console.log('📝 Generating TypeScript declarations...');
    try {
      await $`tsc --project tsconfig.build.json`;
      console.log(`✅ Declarations generated in ${((Date.now() - dtsStart) / 1000).toFixed(2)}s`);
    } catch (error) {
      console.warn(
        `⚠️  TypeScript declaration generation had errors (${((Date.now() - dtsStart) / 1000).toFixed(2)}s)`
      );
      console.warn('   Build will continue - fix type errors when possible');
    }
  }

  console.log(
    `🎉 ${isWatchMode ? 'Rebuild' : 'Build'} finished in ${((Date.now() - totalStart) / 1000).toFixed(2)}s`
  );
}

if (isWatchMode) {
  console.log('👀 Watch mode enabled - watching src/ for changes...');

  build(true).catch((err) => {
    console.error('Initial build failed:', err);
    process.exit(1);
  });

  const watcher = watch('src', { recursive: true }, async (event, filename) => {
    if (filename && filename.endsWith('.ts')) {
      console.log(`\n📝 File changed: ${filename}`);
      try {
        await build(false);
      } catch (err) {
        console.error('Rebuild failed:', err);
      }
    }
  });

  // Keep process alive
  process.on('SIGINT', () => {
    console.log('\n👋 Stopping watch mode...');
    watcher.close();
    process.exit(0);
  });
} else {
  build(true).catch((err) => {
    console.error('Build failed:', err);
    process.exit(1);
  });
}

