import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 120000, // 2 minutes for e2e tests
    include: ['**/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'codex/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
}); 