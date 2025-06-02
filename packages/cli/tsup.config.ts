import { defineConfig } from 'tsup';
import { copy } from 'esbuild-plugin-copy';
import path from 'path';

export default defineConfig({
  clean: true,
  entry: ['src/index.ts', 'src/commands/*.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: false,
  // Ensure that all external dependencies are properly handled.
  // The regex explicitly includes dependencies that should not be externalized.
  noExternal: [
    /^(?!(@electric-sql\/pglite|zod|@elizaos\/core|chokidar|semver|octokit|execa|@noble\/curves)).*/,
  ],
  platform: 'node',
  minify: false,
  target: 'esnext',
  outDir: 'dist',
  tsconfig: 'tsconfig.json',
  banner: {
    js: `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
`,
  },
  esbuildOptions(options) {
    options.alias = {
      '@/src': './src',
    };
  },
  esbuildPlugins: [
    copy({
      // Recommended to resolve assets relative to the tsup.config.ts file directory
      resolveFrom: 'cwd',
      assets: [
        {
          from: './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
          to: './dist',
        },
        {
          from: './node_modules/@electric-sql/pglite/dist/pglite.data',
          to: './dist',
        },
        {
          from: './node_modules/@electric-sql/pglite/dist/pglite.wasm',
          to: './dist',
        },
      ],
      // Setting this to true will output a list of copied files
      verbose: true,
    }),
  ],
});
