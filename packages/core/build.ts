#!/usr/bin/env bun
/**
 * Dual build script for @elizaos/core - generates both Node.js and browser builds
 */

import { createBuildRunner } from '../../build-utils';
import { existsSync, mkdirSync } from 'node:fs';

// Ensure dist directories exist
['dist', 'dist/node', 'dist/browser'].forEach((dir) => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
});

// Browser-specific externals (these should be provided by the host environment)
const browserExternals = [
  // These will be loaded via CDN or bundled by the consuming app
  'sharp', // Image processing - not available in browser
  '@hapi/shot', // Test utility - not needed in browser
  '@sentry/node', // Ensure node SDK is never bundled into the browser build
];

// Node-specific externals (native modules and node-specific packages)
const nodeExternals = [
  'dotenv',
  'sharp',
  'zod',
  '@hapi/shot',
  'crypto-browserify',
  '@sentry/browser',
];

// Shared configuration
const sharedConfig = {
  packageName: '@elizaos/core',
  sourcemap: true,
  minify: false,
  generateDts: true,
};

/**
 * Build for Node.js environment
 */
async function buildNode() {
  console.log('🔨 Building for Node.js...');
  const startTime = Date.now();

  const runNode = createBuildRunner({
    ...sharedConfig,
    buildOptions: {
      entrypoints: ['src/index.node.ts'],
      outdir: 'dist/node',
      target: 'node',
      format: 'esm',
      external: nodeExternals,
      sourcemap: true,
      minify: false,
      generateDts: true,
    },
  });

  await runNode();

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`✅ Node.js build complete in ${duration}s`);
}

/**
 * Build for browser environment
 */
async function buildBrowser() {
  console.log('🌐 Building for Browser...');
  const startTime = Date.now();

  const runBrowser = createBuildRunner({
    ...sharedConfig,
    buildOptions: {
      entrypoints: ['src/index.browser.ts'],
      outdir: 'dist/browser',
      target: 'browser',
      format: 'esm',
      external: browserExternals,
      sourcemap: true,
      minify: true, // Minify for browser to reduce bundle size
      generateDts: false, // Use the same .d.ts files from Node build
      // No additional browser resolver plugins; avoid pulling large node-polyfill trees
      plugins: [],
    },
  });

  await runBrowser();

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`✅ Browser build complete in ${duration}s`);
}

/**
 * Build for both targets
 */
async function buildAll() {
  console.log('🚀 Starting dual build process for @elizaos/core\n');
  const totalStart = Date.now();

  try {
    // Build in parallel for speed
    await Promise.all([buildNode(), buildBrowser()]);

    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
    console.log(`\n🎉 All builds complete in ${totalDuration}s`);

    // Create index files that point to the correct build
    await createIndexFiles();
  } catch (error) {
    console.error('\n❌ Build failed:', error);
    process.exit(1);
  }
}

/**
 * Create index files for proper module resolution
 */
async function createIndexFiles() {
  const fs = await import('node:fs/promises');

  // Create main index.js that uses conditional exports
  const mainIndex = `/**
 * Main entry point for @elizaos/core
 * Automatically selects the correct build based on the environment
 */

// This file is not used directly - package.json conditional exports handle the routing
// See package.json "exports" field for the actual entry points
export * from './node/index.node.js';
`;

  await fs.writeFile('dist/index.js', mainIndex);

  // Create a simple index.d.ts that re-exports from the actual generated types
  // The types directory contains the real TypeScript declarations
  const typeIndex = `// Type definitions for @elizaos/core
// Re-export all types from the generated types directory

export * from './types/index';
`;

  await fs.writeFile('dist/index.d.ts', typeIndex);


  console.log('📝 Created index files and type definitions for module resolution');
}

// Execute the build
buildAll().catch((error) => {
  console.error('Build script error:', error);
  process.exit(1);
});
