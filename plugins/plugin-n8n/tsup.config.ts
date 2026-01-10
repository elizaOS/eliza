import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  tsconfig: './tsconfig.build.json', // Use build-specific tsconfig
  sourcemap: true,
  clean: true,
  format: ['esm'], // Use ESM format like other ElizaOS plugins
  dts: true, // require DTS so we get d.ts in the dist folder on npm
  external: [
    'dotenv', // Externalize dotenv to prevent bundling
    'fs', // Externalize fs to use Node.js built-in module
    'fs-extra', // Externalize fs-extra to prevent bundling issues
    'path', // Externalize other built-ins if necessary
    'https',
    'http',
    'child_process',
    'stream',
    'util',
    'os',
    'url',
    '@elizaos/core',
    '@anthropic-ai/sdk', // Externalize Anthropic SDK
    'anthropic', // Also externalize the anthropic package
    'zod',
    'punycode',
    'node-fetch',
    'agentkeepalive',
  ],
});
