import { defineConfig } from 'tsup';
import { copy } from 'esbuild-plugin-copy';

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
  // Externalize problematic fs-related dependencies
  external: ['fs-extra'],
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
