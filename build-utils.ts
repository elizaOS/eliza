#!/usr/bin/env bun
/**
 * Common build utilities for Bun.build across the monorepo
 */

import type { BuildConfig } from 'bun';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ElizaBuildOptions {
  /** Package root directory */
  root?: string;
  /** Entry points - defaults to ['src/index.ts'] */
  entrypoints?: string[];
  /** Output directory - defaults to 'dist' */
  outdir?: string;
  /** Target environment - defaults to 'node' for packages */
  target?: 'node' | 'bun' | 'browser';
  /** External dependencies */
  external?: string[];
  /** Whether to generate sourcemaps */
  sourcemap?: boolean | 'linked' | 'inline' | 'external';
  /** Whether to minify */
  minify?: boolean;
  /** Additional plugins */
  plugins?: any[];
  /** Format - defaults to 'esm' */
  format?: 'esm' | 'cjs';
  /** Copy assets configuration */
  assets?: Array<{ from: string; to: string }>;
  /** Whether this is a CLI tool */
  isCli?: boolean;
  /** Whether to generate TypeScript declarations (using tsc separately) */
  generateDts?: boolean;
}

/**
 * Get performance timer
 */
export function getTimer() {
  const start = performance.now();
  return {
    elapsed: () => {
      const end = performance.now();
      return (end - start).toFixed(2);
    },
    elapsedMs: () => {
      const end = performance.now();
      return Math.round(end - start);
    }
  };
}

/**
 * Creates a standardized Bun build configuration for ElizaOS packages
 */
export async function createElizaBuildConfig(options: ElizaBuildOptions): Promise<BuildConfig> {
  const timer = getTimer();
  
  const {
    root = process.cwd(),
    entrypoints = ['src/index.ts'],
    outdir = 'dist',
    target = 'node',
    external = [],
    sourcemap = false,
    minify = false,
    plugins = [],
    format = 'esm',
    assets = [],
    isCli = false,
  } = options;

  // Resolve paths relative to root
  const resolvedEntrypoints = entrypoints
    .filter(entry => entry && entry.trim() !== '') // Filter out empty strings
    .map(entry => entry.startsWith('./') ? entry : `./${entry}`);

  // Common external packages for Node.js targets
  const nodeExternals = target === 'node' || target === 'bun' ? [
    'node:*',
    'fs',
    'path',
    'crypto',
    'stream',
    'buffer',
    'util',
    'events',
    'url',
    'http',
    'https',
    'os',
    'child_process',
    'worker_threads',
    'cluster',
    'zlib',
    'querystring',
    'string_decoder',
    'tls',
    'net',
    'dns',
    'dgram',
    'readline',
    'repl',
    'vm',
    'assert',
    'console',
    'process',
    'timers',
    'perf_hooks',
    'async_hooks',
  ] : [];

  // ElizaOS workspace packages that should typically be external
  const elizaExternals = [
    '@elizaos/core',
    '@elizaos/server',
    '@elizaos/client',
    '@elizaos/api-client',
    '@elizaos/plugin-*',
  ];

  // Filter out empty strings and clean up the external array
  const cleanExternals = [...external]
    .filter(ext => ext && !ext.startsWith('//') && ext.trim() !== '');

  const config: BuildConfig = {
    entrypoints: resolvedEntrypoints,
    outdir,
    target: target === 'node' ? 'node' : target,
    format,
    splitting: format === 'esm' && entrypoints.length > 1,
    sourcemap,
    minify,
    external: [
      ...nodeExternals,
      ...elizaExternals,
      ...cleanExternals,
    ],
    plugins,
    naming: {
      entry: '[dir]/[name].[ext]',
      chunk: '[name]-[hash].[ext]',
      asset: '[name]-[hash].[ext]',
    },
  };

  return config;
}

/**
 * Copy assets after build
 */
export async function copyAssets(assets: Array<{ from: string; to: string }>) {
  if (!assets.length) return;
  
  const timer = getTimer();
  const { cp } = await import('node:fs/promises');
  
  console.log(`Copying ${assets.length} asset(s)...`);
  for (const asset of assets) {
    if (existsSync(asset.from)) {
      const assetTimer = getTimer();
      await cp(asset.from, asset.to, { recursive: true });
      console.log(`  ✓ Copied ${asset.from} to ${asset.to} (${assetTimer.elapsed()}ms)`);
    }
  }
  console.log(`Assets copied in ${timer.elapsed()}ms`);
}

/**
 * Generate TypeScript declarations using tsc
 */
export async function generateDts(tsconfigPath = './tsconfig.build.json', throwOnError = false) {
  const timer = getTimer();
  const { $ } = await import('bun');
  
  if (!existsSync(tsconfigPath)) {
    console.warn(`TypeScript config not found at ${tsconfigPath}, skipping d.ts generation`);
    return;
  }
  
  console.log('Generating TypeScript declarations...');
  try {
    // Use incremental compilation for faster subsequent builds
    await $`tsc --emitDeclarationOnly --incremental --project ${tsconfigPath}`;
    console.log(`✓ TypeScript declarations generated successfully (${timer.elapsed()}ms)`);
  } catch (error: any) {
    console.error(`✗ Failed to generate TypeScript declarations (${timer.elapsed()}ms)`);
    console.error('This is usually due to test files or type errors that don\'t affect the build.');
    console.error('Error details:', error.message || error);
    
    if (throwOnError) {
      throw error;
    } else {
      console.warn('Continuing build without TypeScript declarations...');
    }
  }
}

/**
 * Clean build artifacts
 */
export async function cleanBuild(outdir = 'dist') {
  const timer = getTimer();
  const { rm } = await import('node:fs/promises');
  
  if (existsSync(outdir)) {
    await rm(outdir, { recursive: true, force: true });
    console.log(`✓ Cleaned ${outdir} directory (${timer.elapsed()}ms)`);
  } else {
    console.log(`✓ ${outdir} directory already clean (${timer.elapsed()}ms)`);
  }
}
