#!/usr/bin/env bun

import { build } from 'bun';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';

const outDir = join(import.meta.dir, '..', 'dist');

// Clean output directory
try {
  rmSync(outDir, { recursive: true, force: true });
} catch {
  // Directory doesn't exist, ignore
}
mkdirSync(outDir, { recursive: true });

// Build Node.js version
const nodeResult = await build({
  entrypoints: [join(import.meta.dir, 'src', 'index.ts')],
  outdir: join(outDir, 'node'),
  target: 'node',
  format: 'esm',
  splitting: false,
  sourcemap: 'external',
  minify: false,
  external: ['@elizaos/core', 'drizzle-orm'],
  naming: {
    entry: 'index.node.js',
  },
});

if (!nodeResult.success) {
  console.error('Node build failed:', nodeResult.logs);
  process.exit(1);
}

// Build browser version
const browserResult = await build({
  entrypoints: [join(import.meta.dir, 'src', 'index.ts')],
  outdir: join(outDir, 'browser'),
  target: 'browser',
  format: 'esm',
  splitting: false,
  sourcemap: 'external',
  minify: false,
  external: ['@elizaos/core', 'drizzle-orm'],
  naming: {
    entry: 'index.browser.js',
  },
});

if (!browserResult.success) {
  console.error('Browser build failed:', browserResult.logs);
  process.exit(1);
}

// Build CJS version
const cjsResult = await build({
  entrypoints: [join(import.meta.dir, 'src', 'index.ts')],
  outdir: join(outDir, 'cjs'),
  target: 'node',
  format: 'cjs',
  splitting: false,
  sourcemap: 'external',
  minify: false,
  external: ['@elizaos/core', 'drizzle-orm'],
  naming: {
    entry: 'index.node.cjs',
  },
});

if (!cjsResult.success) {
  console.error('CJS build failed:', cjsResult.logs);
  process.exit(1);
}

console.log('✅ Build completed successfully');
console.log(`   Node:    ${outDir}/node/index.node.js`);
console.log(`   Browser: ${outDir}/browser/index.browser.js`);
console.log(`   CJS:     ${outDir}/cjs/index.node.cjs`);

