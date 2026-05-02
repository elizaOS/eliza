import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    setupFiles: ['./__tests__/core-test-mock.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      reporter: ['text', 'json', 'html'],
    },
  },
});
