import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  entry: ['src/index.ts', 'src/commands/*.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: false,
  external: ['@electric-sql/pglite', 'zod', '@elizaos/core'],
  noExternal: [/^(?!(@electric-sql\/pglite|zod)).*/],
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
