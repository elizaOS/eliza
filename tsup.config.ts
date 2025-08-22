import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  external: ['@elizaos/core'],
  noExternal: ['ai', '@ai-sdk/openai', 'lru-cache', 'p-retry']
});
