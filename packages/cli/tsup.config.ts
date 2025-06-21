import { defineConfig } from 'tsup';
import { copy } from 'esbuild-plugin-copy';
import path from 'path';

const isTestEnv = process.env.ELIZA_TEST_MODE === 'true' || process.env.VITEST === 'true';

export default defineConfig({
  // Avoid deleting the existing `dist` directory when running inside the test
  // suite. When several CLI command tests execute concurrently they may each
  // trigger a build. The default `clean: true` behaviour wipes the directory at
  // the start of every build which causes a race-condition where another test
  // (or a child Bun process) might attempt to invoke `dist/index.js` while it
  // has been temporarily removed.  By disabling `clean` in test environments
  // we guarantee the file always exists, eliminating the intermittent
  // "Module not found '/path/to/dist/index.js'" errors seen in CI.
  clean: !isTestEnv,
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
    'src/commands/scenario/index.ts',
    'src/commands/scenario/generate.ts',
    'src/commands/scenario/run-scenario.ts',
    'src/commands/scenario/action-tracker.ts',
    'src/commands/plugins/index.ts',
    'src/commands/start/index.ts',
    'src/commands/test/index.ts',
    'src/commands/update/index.ts',
    'src/commands/env/index.ts',
    'src/scenario-runner/index.ts',
    'src/scenario-runner/types.ts',
  ],
  format: ['esm'],
  dts: true,
  sourcemap: false,
  // Externalize problematic fs-related dependencies
  external: [
    'express',
    'fs-extra',
    'multer',
    'socket.io',
    'body-parser',
    'cors',
    'helmet',
    'express-rate-limit',
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
          from: './templates/**/*',
          to: './dist/templates',
        },
        {
          from: './templates/**/.*',
          to: './dist/templates',
        },
      ],
      // Setting this to true will output a list of copied files
      verbose: true,
    }) as any,
  ],
});
