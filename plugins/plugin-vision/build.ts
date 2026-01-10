#!/usr/bin/env bun

/**
 * Build script using bun build
 * Replaces tsup with native bun build functionality
 */

import { $ } from 'bun';
import { buildConfig, workersConfig } from './build.config';

async function build() {
  console.log('🏗️  Building package...');

  // Clean dist directory
  await $`rm -rf dist`;

  // Build main package
  console.log('📦 Building main package...');
  const mainResult = await Bun.build(buildConfig);

  if (!mainResult.success) {
    console.error('❌ Main build failed:');
    for (const message of mainResult.logs) {
      console.error(message);
    }
    process.exit(1);
  }

  console.log(`✅ Built ${mainResult.outputs.length} main files`);

  // Check if workers exist before building them
  try {
    await $`ls src/workers/*.ts > /dev/null 2>&1`;

    console.log('👷 Building workers...');
    const workersResult = await Bun.build(workersConfig);

    if (!workersResult.success) {
      console.error('❌ Workers build failed:');
      for (const message of workersResult.logs) {
        console.error(message);
      }
      process.exit(1);
    }

    console.log(`✅ Built ${workersResult.outputs.length} worker files`);
  } catch (error) {
    console.log('ℹ️  No workers found, skipping worker build');
  }

  // Generate TypeScript declarations
  console.log('📝 Generating TypeScript declarations...');
  try {
    await $`tsc --project tsconfig.build.json`;
    console.log('✅ TypeScript declarations generated');
  } catch (error) {
    console.warn('⚠️ TypeScript declaration generation had issues, but continuing...');
  }

  console.log('✅ Build complete!');
}

build().catch(console.error);
