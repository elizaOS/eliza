import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['@elizaos/core'],
  platform: 'node',
  target: 'node20',
  minify: false,
  splitting: false,
  treeshake: true,
}); 