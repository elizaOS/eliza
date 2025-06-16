import { defineConfig } from 'tsup';
import { copy } from 'esbuild-plugin-copy';
import path from 'path';

export default defineConfig({
  clean: true,
  entry: [
    'src/index.ts',
    'src/commands/*.ts',
    'src/commands/agent/index.ts',
    'src/commands/agent/actions/index.ts',
    'src/commands/agent/manage/index.ts',
    'src/commands/create/index.ts',
    'src/commands/create/actions/index.ts',
    'src/commands/create/manage/index.ts',
    'src/commands/shared/index.ts',
  ],
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
    // Use a transform to replace @/src imports
    options.define = {
      ...options.define,
    };
  },
  esbuildPlugins: [
    copy({
      // Recommended to resolve assets relative to the tsup.config.ts file directory
      resolveFrom: 'cwd',
      assets: [
        {
          from: '../../node_modules/@electric-sql/pglite/dist/pglite.data',
          to: './dist',
        },
        {
          from: '../../node_modules/@electric-sql/pglite/dist/pglite.wasm',
          to: './dist',
        },
        {
          from: './templates',
          to: './dist/templates',
        },
      ],
      // Setting this to true will output a list of copied files
      verbose: true,
    }) as any,
  ],
});
