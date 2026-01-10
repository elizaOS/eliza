/**
 * Build script for the Ollama plugin TypeScript package.
 */

import { build } from 'bun';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(import.meta.path), '..');
const DIST = join(ROOT, 'dist');

// Clean dist directory
if (existsSync(DIST)) {
  rmSync(DIST, { recursive: true });
}
mkdirSync(DIST, { recursive: true });
mkdirSync(join(DIST, 'node'), { recursive: true });
mkdirSync(join(DIST, 'cjs'), { recursive: true });

// Build Node.js ESM version
console.log('Building Node.js ESM bundle...');
await build({
  entrypoints: [join(ROOT, 'typescript', 'index.ts')],
  outdir: join(DIST, 'node'),
  target: 'node',
  format: 'esm',
  splitting: false,
  sourcemap: 'linked',
  minify: false,
  external: ['@elizaos/core', 'ai', 'ollama-ai-provider'],
  naming: {
    entry: 'index.node.js',
  },
});

// Build CJS version
console.log('Building CJS bundle...');
await build({
  entrypoints: [join(ROOT, 'typescript', 'index.ts')],
  outdir: join(DIST, 'cjs'),
  target: 'node',
  format: 'cjs',
  splitting: false,
  sourcemap: 'linked',
  minify: false,
  external: ['@elizaos/core', 'ai', 'ollama-ai-provider'],
  naming: {
    entry: 'index.node.cjs',
  },
});

console.log('Build complete!');

