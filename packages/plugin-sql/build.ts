#!/usr/bin/env bun
/**
 * Dual build script for @elizaos/plugin-sql (Node + Browser)
 */

import { runBuild } from '../../build-utils';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

async function buildAll() {
  // Node build (server): Postgres + PGlite
  const nodeOk = await runBuild({
    packageName: '@elizaos/plugin-sql',
    buildOptions: {
      entrypoints: ['src/index.node.ts'],
      outdir: 'dist/node',
      target: 'node',
      format: 'esm',
      external: [
        'dotenv',
        '@reflink/reflink',
        '@node-llama-cpp',
        'agentkeepalive',
        'uuid',
        '@elizaos/core',
        '@electric-sql/pglite',
        'zod',
        'fs',
        'path',
        'postgres',
        'pg',
      ],
      sourcemap: true,
      minify: false,
      // d.ts for node build handled by package-wide tsc; keep true for parity
      generateDts: true,
    },
  });

  if (!nodeOk) return false;

  // Browser build (client): PGlite only, no Node builtins
  const browserOk = await runBuild({
    packageName: '@elizaos/plugin-sql',
    buildOptions: {
      entrypoints: ['src/index.browser.ts'],
      outdir: 'dist/browser',
      target: 'browser',
      format: 'esm',
      // Keep core external to avoid bundling workspace deps; avoid Node externals
      // Externalize PGlite and Drizzle so Next/Webpack can resolve their browser exports
      external: [
        '@elizaos/core',
        '@electric-sql/pglite',
        '@electric-sql/pglite/vector',
        '@electric-sql/pglite/contrib/fuzzystrmatch',
        'drizzle-orm',
        'drizzle-orm/pglite',
      ],
      sourcemap: true,
      minify: false,
      generateDts: true,
    },
  });

  if (!browserOk) return false;

  // Ensure declaration entry points are present for consumers (keep minimal)
  const distDir = join(process.cwd(), 'dist');
  const browserDir = join(distDir, 'browser');
  const nodeDir = join(distDir, 'node');
  if (!existsSync(browserDir)) {
    await mkdir(browserDir, { recursive: true });
  }
  if (!existsSync(nodeDir)) {
    await mkdir(nodeDir, { recursive: true });
  }

  // Root types alias to node by default for server editors
  const rootIndexDtsPath = join(distDir, 'index.d.ts');
  const rootAlias = [
    'export * from "./node/index";',
    'export { default } from "./node/index";',
    '',
  ].join('\n');
  await writeFile(rootIndexDtsPath, rootAlias, 'utf8');

  // Browser alias (stable entry) with explicit types for subpath
  const browserIndexDtsPath = join(browserDir, 'index.d.ts');
  const browserAlias = [
    'export * from "./index.browser";',
    'export { default } from "./index.browser";',
    '',
  ].join('\n');
  await writeFile(browserIndexDtsPath, browserAlias, 'utf8');

  // Node alias to index.node (stable entry)
  const nodeIndexDtsPath = join(nodeDir, 'index.d.ts');
  const nodeAlias = [
    'export * from "./index.node";',
    'export { default } from "./index.node";',
    '',
  ].join('\n');
  await writeFile(nodeIndexDtsPath, nodeAlias, 'utf8');

  return true;
}

buildAll()
  .then((ok) => {
    if (!ok) process.exit(1);
  })
  .catch((error) => {
    console.error('Build script error:', error);
    process.exit(1);
  });
