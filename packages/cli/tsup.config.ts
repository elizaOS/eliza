import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  entry: ['src/index.ts', 'src/commands/*.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: false,
  // Ensure that all external dependencies are properly handled.
  // The regex explicitly includes dependencies that should not be externalized.
  noExternal: [/^(?!(@electric-sql\/pglite|zod|@elizaos\/core|chokidar|semver|octokit|execa)).*/],
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
});
