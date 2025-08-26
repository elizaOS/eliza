#!/usr/bin/env bun
/**
 * Build script for @elizaos/utils
 */

import type { BuildConfig } from 'bun';

const isWatchMode = process.argv.includes('--watch');

async function build() {
    const timer = {
        elapsed: () => {
            const end = performance.now();
            return ((end - start) / 1000).toFixed(2);
        },
        elapsedMs: () => {
            const end = performance.now();
            return Math.round(end - start);
        },
    };

    const start = performance.now();

    console.log(`🚀 Building @elizaos/utils...\n`);

    try {
        // Clean previous build
        const { rm } = await import('node:fs/promises');
        const { existsSync } = await import('node:fs');

        if (existsSync('dist')) {
            await rm('dist', { recursive: true, force: true });
            console.log(`✓ Cleaned dist directory`);
        }

        // Create build configuration
        const config: BuildConfig = {
            entrypoints: ['src/index.ts'],
            outdir: 'dist',
            target: 'node',
            format: 'esm',
            sourcemap: false,
            minify: false,
            external: [
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
            ],
        };

        console.log('Bundling with Bun...');
        const result = await Bun.build(config);

        if (!result.success) {
            console.error('✗ Build failed:', result.logs);
            return false;
        }

        const totalSize = result.outputs.reduce((sum, output) => sum + output.size, 0);
        const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
        console.log(`✓ Built ${result.outputs.length} file(s) - ${sizeMB}MB`);

        // Generate TypeScript declarations
        const { $ } = await import('bun');
        console.log('Generating TypeScript declarations...');
        try {
            await $`tsc --emitDeclarationOnly --incremental --project tsconfig.build.json`;
            console.log(`✓ TypeScript declarations generated successfully`);
        } catch (error) {
            console.warn('⚠ Failed to generate TypeScript declarations, continuing...');
        }

        console.log(`\n✅ @elizaos/utils build complete!`);
        console.log(`⏱️  Total build time: ${timer.elapsed()}s\n`);

        return true;
    } catch (error) {
        console.error('Build error:', error);
        return false;
    }
}

async function startWatchMode() {
    console.log('👀 Starting watch mode...\n');

    // Initial build
    const buildSuccess = await build();

    if (buildSuccess) {
        const { watch } = await import('node:fs');
        const { join } = await import('node:path');

        const srcDir = join(process.cwd(), 'src');

        console.log(`📁 Watching ${srcDir} for changes...`);
        console.log('💡 Press Ctrl+C to stop\n');

        const watcher = watch(srcDir, { recursive: true }, async (eventType, filename) => {
            if (filename && (filename.endsWith('.ts') || filename.endsWith('.js'))) {
                console.clear();
                const timestamp = new Date().toLocaleTimeString();
                console.log(`[${timestamp}] 🔄 File changed: ${filename}`);
                await build();
                console.log(`📁 Watching ${srcDir} for changes...`);
                console.log('💡 Press Ctrl+C to stop\n');
            }
        });

        // Handle process exit
        const cleanup = () => {
            watcher.close();
            console.log('\n\n👋 Stopping watch mode...');
            process.exit(0);
        };

        process.once('SIGINT', cleanup);
        process.once('SIGTERM', cleanup);
    }
}

if (isWatchMode) {
    startWatchMode();
} else {
    build().then((success) => {
        if (!success) {
            process.exit(1);
        }
    });
}
