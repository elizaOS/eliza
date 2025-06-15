import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/test/**',
        '**/__tests__/**',
        '**/setupTests.ts',
        'vitest.setup.ts'
      ],
    },
  },
  resolve: {
    alias: {
      '@elizaos/core': path.resolve(__dirname, '../core/src/index.ts'),
    },
  },
});
