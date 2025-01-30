import { defineConfig } from "tsup";

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    external: [
      'net',
      'tls',
      'crypto',
      'stream',
      'buffer',
      'events',
      'util',
      'ws',
      '@phala/dstack-sdk'
    ],
    noExternal: [
      '@solana/web3.js'
    ],
    platform: 'node',
    target: 'node18'
})
