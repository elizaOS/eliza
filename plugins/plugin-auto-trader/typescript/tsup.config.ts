import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  tsconfig: './tsconfig.build.json', // Use build-specific tsconfig
  sourcemap: true,
  clean: true,
  format: ['esm'], // Ensure you're targeting CommonJS
  dts: false, // Disable dts generation, we'll use tsc directly
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
    'rpc-websockets',
    '@jup-ag/core',
    'zod',
    'ws',
    'combined-stream',
    'form-data',
    'proxy-from-env',
    'follow-redirects',
  ],
});
