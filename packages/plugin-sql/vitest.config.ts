import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Increase timeout for all tests
    testTimeout: 30000, // 30 seconds
    // Increase hook timeout specifically
    hookTimeout: 40000, // 40 seconds
  },
});
