import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  tsconfig: './tsconfig.build.json', // Use build-specific tsconfig
  sourcemap: true,
  format: ['esm'], // Ensure you're targeting CommonJS
  dts: true, // Skip DTS generation to avoid external import issues // Ensure you're targeting CommonJS
  external: [
    'dotenv', // Externalize dotenv to prevent bundling
    'fs', // Externalize fs to use Node.js built-in module
    'path', // Externalize other built-ins if necessary
    '@reflink/reflink',
    '@node-llama-cpp',
    'https',
    'http',
    'agentkeepalive',
    'safe-buffer',
    'base-x',
    'bs58',
    'borsh',
    'stream',
    'buffer',
    // Add other modules you want to externalize
    '@phala/dstack-sdk',
    'undici',
    '@elizaos/core',
    'zod',
  ],
});
