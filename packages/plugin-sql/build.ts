#!/usr/bin/env bun

/**
 * Build script using bun build
 */

import { $ } from 'bun';
import { buildConfig } from './build.config';

async function build() {
  console.log('🏗️  Building package...');

  // Clean dist directory
  await $`rm -rf dist`;

  // Build with bun
  const result = await Bun.build(buildConfig);

  if (!result.success) {
    console.error('❌ Build failed:');
    for (const message of result.logs) {
      console.error(message);
    }
    process.exit(1);
  }

  console.log(`✅ Built ${result.outputs.length} files`);

  // Copy main index.js to dist root for proper module resolution
  console.log('📁 Copying main index.js to dist root...');
  try {
    await $`cp dist/src/index.js dist/index.js`;
    await $`cp dist/src/index.js.map dist/index.js.map`;
    console.log('✅ Main index files copied to dist root');
  } catch (error) {
    console.warn('⚠️ Failed to copy main index files, but continuing...');
  }

  // Generate TypeScript declarations
  console.log('📝 Generating TypeScript declarations...');
  try {
    await $`tsc --project tsconfig.build.json`;
    console.log('✅ TypeScript declarations generated');
  } catch (_error) {
    console.warn('⚠️ TypeScript declaration generation had issues, but continuing...');
  }

  console.log('✅ Build complete!');
}

build().catch(console.error);
