import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  clean: true,
  format: ['esm'],
  target: 'node18',
  dts: true,
  tsconfig: './tsconfig.build.json',
  // No need for source maps or watching for a config package
  sourcemap: false,
  // Skip minification to keep the exported paths readable
  minify: false,
  // Don't bundle - this package just re-exports configs
  bundle: false,
});
