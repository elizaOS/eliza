#!/usr/bin/env bun

/**
 * Build script using bun build
 * Replaces tsup with native bun build functionality
 */

import { $ } from 'bun';
import { buildConfig } from './build.config';

async function build() {
  // eslint-disable-next-line no-console
  console.log('🏗️  Building package...');

  // Clean dist directory
  await $`rm -rf dist`;

  // Build with bun
  const result = await Bun.build(buildConfig);

  if (!result.success) {
    // eslint-disable-next-line no-console
    console.error('❌ Build failed:');
    for (const message of result.logs) {
      // eslint-disable-next-line no-console
      console.error(message);
    }
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`✅ Built ${result.outputs.length} files`);

  // Generate TypeScript declarations

  // eslint-disable-next-line no-console
  console.log('📝 Generating TypeScript declarations...');
  try {
    await $`tsc --project tsconfig.build.json`;

    // eslint-disable-next-line no-console
    console.log('✅ TypeScript declarations generated');
  } catch (_error) {
    // eslint-disable-next-line no-console
    console.warn('⚠️ TypeScript declaration generation had issues, but continuing...');
  }

  // eslint-disable-next-line no-console
  console.log('✅ Build complete!');
}

// eslint-disable-next-line no-console
build().catch(console.error);
