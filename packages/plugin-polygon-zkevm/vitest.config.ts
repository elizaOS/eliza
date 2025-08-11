import { defineConfig } from 'vitest/config';
import path from 'node:path';
import tsconfigPaths from 'vite-tsconfig-paths';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default defineConfig({
  plugins: [tsconfigPaths() as any],
  test: {
    globals: true, // Enable global API (describe, it, expect, etc.)
    environment: 'node',
    // Path is relative to this config file (packages/plugin-polygon-zkevm/)
    setupFiles: [path.resolve(__dirname, 'vitest.setup.ts')],
    // Optional: increase test timeout for integration tests if needed
    testTimeout: 30000,

    // Exclude deprecated test files
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/src/__tests__/**',
      '**/src/services/__tests__/**',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
