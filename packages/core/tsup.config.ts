import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/specs/v1/index.ts',
    'src/specs/v2/index.ts'
  ],
  outDir: 'dist',
  clean: true,
  format: ['esm'],
  target: 'node18',
  dts: true,
  tsconfig: './tsconfig.build.json', // Use build-specific tsconfig
  external: [
    'dotenv',
    'fs',
    'path',
    'node:fs',
    'node:path',
    'node:crypto',
    'node:web',
    'node:stream',
    'node:buffer',
    'node:util',
    'node:events',
    'node:url',
    'node:http',
    'node:https',
    'http',
    'https',
    'sharp',
    '@solana/web3.js',
    'zod',
    '@hapi/shot',
    '@opentelemetry/api',
    '@opentelemetry/context-async-hooks',
    '@opentelemetry/sdk-trace-node',
  ],
  sourcemap: false,
  onSuccess: async () => {
    // Remove test directories from dist
    const { execSync } = await import('child_process');
    try {
      execSync('find dist -name "__tests__" -type d -exec rm -rf {} + 2>/dev/null || true', { stdio: 'ignore' });
      execSync('find dist -name "test_resources" -type d -exec rm -rf {} + 2>/dev/null || true', { stdio: 'ignore' });
    } catch (error) {
      // Ignore errors if directories don't exist
    }
  },
});
