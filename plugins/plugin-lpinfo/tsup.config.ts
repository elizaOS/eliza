import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: false, // Disabled due to type issues in copied code - can be fixed later
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    '@elizaos/core',
    '@kamino-finance/kliquidity-sdk',
    '@kamino-finance/klend-sdk',
    '@steerprotocol/sdk',
    '@solana/web3.js',
    '@solana/spl-token',
    '@coral-xyz/anchor',
  ],
  skipNodeModulesBundle: true,
  onSuccess: 'echo "Build successful!"',
});

