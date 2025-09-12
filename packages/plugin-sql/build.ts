#!/usr/bin/env bun
/**
 * Dual build script for @elizaos/plugin-sql (Node + Browser)
 */

import { runBuild } from '../../build-utils';

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
      ],
      sourcemap: true,
      minify: false,
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
      external: ['@elizaos/core'],
      sourcemap: true,
      minify: false,
      generateDts: false,
    },
  });

  return browserOk;
}

buildAll().then((ok) => {
  if (!ok) process.exit(1);
}).catch((error) => {
  console.error('Build script error:', error);
  process.exit(1);
});
