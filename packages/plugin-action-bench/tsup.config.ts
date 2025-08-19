import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['@elizaos/core'],
  treeshake: true,
  splitting: false,
  outExtension({ format }) {
    // Ensure correct file extensions for different formats
    if (format === 'cjs') return { js: '.cjs' };
    if (format === 'esm') return { js: '.js' };
    return {};
  },
});

