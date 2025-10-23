#!/usr/bin/env bun
/**
 * Build script for @elizaos/react
 */

import { createBuildRunner } from '../../build-utils';
import { existsSync, mkdirSync } from 'node:fs';

// Ensure dist directory exists
if (!existsSync('dist')) {
    mkdirSync('dist', { recursive: true });
}

// External dependencies that should not be bundled
const externals = [
    'react',
    'react-dom',
    '@tanstack/react-query',
    '@elizaos/api-client',
    '@elizaos/core',
];

// Build configuration
const sharedConfig = {
    packageName: '@elizaos/react',
    sourcemap: true,
    minify: false,
    generateDts: true,
};

/**
 * Build the package
 */
async function build() {
    console.log('🔨 Building @elizaos/react...');
    const startTime = Date.now();

    const run = createBuildRunner({
        ...sharedConfig,
        buildOptions: {
            entrypoints: ['src/index.ts'],
            outdir: 'dist',
            target: 'browser',
            format: 'esm',
            external: externals,
            sourcemap: true,
            minify: false,
            generateDts: true,
        },
    });

    await run();

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Build complete in ${duration}s`);
}

// Execute the build
build().catch((error) => {
    console.error('Build script error:', error);
    process.exit(1);
});

