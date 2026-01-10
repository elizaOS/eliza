import path from 'path';
import { defineConfig } from 'tsup';
import { copy } from 'esbuild-plugin-copy';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  tsconfig: './tsconfig.build.json', // Use build-specific tsconfig
  sourcemap: true,
  clean: true,
  format: ['esm'], // Ensure you're targeting CommonJS
  dts: true,
  external: [
    'dotenv', // Externalize dotenv to prevent bundling
    'fs', // Externalize fs to use Node.js built-in module
    'path', // Externalize other built-ins if necessary
    '@reflink/reflink',
    'https',
    'http',
    'agentkeepalive',
    'zod',
  ],
  esbuildOptions(options) {
    options.alias = {
      '@/src': './src',
    };
  },
  esbuildPlugins: [
    copy({
      assets: {
        from: [path.resolve(__dirname, '../../node_modules/pdfjs-dist/legacy/build/pdf.worker.js')],
        to: [path.resolve(__dirname, 'dist')],
      },
    }),
  ],
});
