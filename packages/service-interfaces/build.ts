#!/usr/bin/env bun
/**
 * Dual build script for @elizaos/service-interfaces - generates both Node.js and browser builds
 */

import { createBuildRunner } from '../../build-utils';
import { existsSync, mkdirSync } from 'node:fs';

// Ensure dist directories exist
['dist', 'dist/node', 'dist/browser'].forEach((dir) => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
});

// Browser-specific externals (service interfaces are pure TypeScript, minimal externals needed)
const browserExternals: string[] = [];

// Node-specific externals (service interfaces are pure TypeScript, minimal externals needed)
const nodeExternals: string[] = [];

// Shared configuration
const sharedConfig = {
  packageName: '@elizaos/service-interfaces',
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
      generateDts: false, // We'll generate declarations separately for all entry points
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
  console.log('🚀 Starting dual build process for @elizaos/service-interfaces');
  const totalStart = Date.now();

  try {
    // Build everything in parallel for maximum speed
    const [nodeResult, browserResult, _] = await Promise.all([
      buildNode(),
      buildBrowser(),
      generateTypeScriptDeclarations(), // Run in parallel
    ]);

    const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
    console.log(`\n🎉 All builds complete in ${totalDuration}s`);
  } catch (error) {
    console.error('\n❌ Build failed:', error);
    process.exit(1);
  }
}

/**
 * Generate TypeScript declarations for all entry points
 */
async function generateTypeScriptDeclarations() {
  const fs = await import('node:fs/promises');
  const { $ } = await import('bun');

  console.log('📝 Generating TypeScript declarations...');
  const startTime = Date.now();

  try {
    // Generate TypeScript declarations using tsc
    console.log('   Compiling TypeScript declarations...');
    await $`tsc --project tsconfig.declarations.json`;

    // Ensure directories exist for conditional exports
    await fs.mkdir('dist/node', { recursive: true });
    await fs.mkdir('dist/browser', { recursive: true });

    // Create re-export files for conditional exports structure
    // dist/node/index.d.ts - points to the Node.js entry point
    await fs.writeFile(
      'dist/node/index.d.ts',
      `// Type definitions for @elizaos/service-interfaces (Node.js)\nexport * from '../index.node';\n`
    );

    // dist/browser/index.d.ts - points to the browser entry point
    await fs.writeFile(
      'dist/browser/index.d.ts',
      `// Type definitions for @elizaos/service-interfaces (Browser)\nexport * from '../index.browser';\n`
    );

    // Create main index.js for runtime fallback
    await fs.writeFile(
      'dist/index.js',
      `// Main entry point fallback for @elizaos/service-interfaces\nexport * from './node/index.node.js';\n`
    );

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ TypeScript declarations generated in ${duration}s`);
  } catch (error) {
    console.error('❌ Failed to generate TypeScript declarations:', error);
    throw error;
  }
}

// Execute the build
buildAll().catch((error) => {
  console.error('Build script error:', error);
  process.exit(1);
});
