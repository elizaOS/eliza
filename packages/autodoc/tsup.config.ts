import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: 'node23',
  outDir: 'dist',
  tsconfig: './tsconfig.build.json', // Use build-specific tsconfig
  treeshake: true,
});
