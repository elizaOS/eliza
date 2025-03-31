import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.js'],
    setupFiles: ['test/setup.js'],
    testTimeout: 30000,
  },
});
