#!/usr/bin/env bun
/**
 * Build script for @elizaos/react
 */

import { createBuildRunner } from '../../build-utils';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
 * Create root index.d.ts that re-exports from the actual declarations
 */
function createRootDeclarations() {
    const rootDts = join('dist', 'index.d.ts');
    const content = `export * from './react/src/index';\n`;
    writeFileSync(rootDts, content, 'utf-8');
    console.log('✓ Created root index.d.ts');
}

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

    // Create root index.d.ts after build
    try {
        createRootDeclarations();
    } catch (error) {
        console.warn('Failed to create root declarations:', error);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Build complete in ${duration}s`);
}

// Execute the build
build().catch((error) => {
    console.error('Build script error:', error);
    process.exit(1);
});

