import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  tsconfig: './tsconfig.build.json', // Use build-specific tsconfig
  sourcemap: true,
  clean: false,
  format: ['esm'], // Ensure you're targeting CommonJS
  dts: false, // Disabled until error type issues are resolved
  external: [
    'dotenv', // Externalize dotenv to prevent bundling
    'fs', // Externalize fs to use Node.js built-in module
    'path', // Externalize other built-ins if necessary
    'https',
    'http',
    'agentkeepalive',
    'safe-buffer',
    'base-x',
    'bs58',
    'borsh',
    '@solana/buffer-layout',
    'stream',
    'buffer',
    'querystring',
    '@elizaos/core',
    'punycode',
    'whatwg-url',
    'events',
    '@solana/web3.js',
    'zod',
  ],
});
