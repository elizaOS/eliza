import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  tsconfig: './tsconfig.build.json', // Use build-specific tsconfig
  sourcemap: true,
  clean: true,
  format: ['esm'],
  dts: true,
  external: [
    'dotenv', // Externalize dotenv to prevent bundling
    'fs', // Externalize fs to use Node.js built-in module
    'path', // Externalize other built-ins if necessary
    // Also externalize node: prefixed built-ins (used by this plugin)
    'node:fs',
    'node:path',
    'node:http',
    'node:https',
    'node:crypto',
    'node:os',
    'node:url',
    'node:readline',
    '@reflink/reflink',
    '@node-llama-cpp',
    'https',
    'http',
    'agentkeepalive',
    '@elizaos/core',
    // Add other modules you want to externalize
  ],
});
