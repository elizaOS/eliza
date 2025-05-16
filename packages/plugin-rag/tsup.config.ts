import { defineConfig } from 'tsup';
import { copy } from 'esbuild-plugin-copy';
import path from 'path';

export default defineConfig({
  entry: ['src/index.ts', 'src/rag.worker.ts'],
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
    '@elizaos/core',
    // Add other modules you want to externalize
  ],
  esbuildOptions(options) {
    options.alias = {
      '@/src': './src',
    };
  },
  esbuildPlugins: [
    copy({
      assets: {
        from: [
          path.resolve(__dirname, '../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'),
        ],
        to: [path.resolve(__dirname, 'dist')],
      },
    }),
  ],
});
