import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false, // Allow parallel execution
      },
    },
    alias: {
      '@/src': path.resolve(__dirname, 'src'),
    },
    include: ['src/__tests__/integration/**/*.test.ts'],
    testTimeout: 30000, // 30 seconds for integration tests
    hookTimeout: 30000,
  },
}); 