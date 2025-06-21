import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  format: ['esm'],
  external: ['@elizaos/core'],
  dts: false, // Disable DTS generation to avoid cross-package issues
});