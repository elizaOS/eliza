import * as tsup from 'tsup';
import type { Options } from 'tsup';

const sharedConfig: Options = {
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  treeshake: true,
  external: [
    '@elizaos/core',
    'simple-git',
    '@octokit/rest',
    '@octokit/types',
    '@octokit/webhooks-types',
    'glob',
    'zod',
  ],
};

async function build() {
  // Build to root-level dist/
  await tsup.build({
    ...sharedConfig,
    outDir: '../dist',
    platform: 'node',
    target: 'node18',
    format: ['esm'],
  });

  console.log('Build complete!');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
