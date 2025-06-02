import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/migrate.ts'],
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  format: ['esm'],
  dts: true,
  tsconfig: './tsconfig.build.json', // Use build-specific tsconfig
  external: [
    '@drizzle-orm/better-sqlite3',
    'better-sqlite3',
    'pg',
    '@elizaos/core',
    'fs',
    'path',
    'url',
  ],
  // Improve source map configuration
  esbuildOptions(options) {
    options.sourceRoot = './'; // Set source root to help with source mapping
    options.sourcesContent = true;
    options.outbase = './src'; // Makes output paths match input structure
    options.platform = 'node'; // Ensure node platform for proper handling
  },
  keepNames: true, // Preserve names for better debugging
});
