import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Increase timeout for all tests
    testTimeout: 30000, // 30 seconds
    // Increase hook timeout specifically
    hookTimeout: 40000, // 40 seconds
    // Set up environment variables for tests
    env: {
      // This will be merged with process.env
      NODE_ENV: 'test',
    },
    // Define test environment setup
    setupFiles: ['dotenv/config'],
    fileParallelism: false,
  },
});
