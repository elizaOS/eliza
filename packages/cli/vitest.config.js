import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    testMatch: ['**/test/**/*.test.js'],
    alias: {
      '@/': resolve(__dirname, './'),
    },
    testTimeout: 180000, // Increased to 3 minutes
    hookTimeout: 180000, // Added hook timeout
    teardownTimeout: 30000, // Added teardown timeout
    silent: false, // Ensure logs are visible
    bail: 1, // Stop after first failure
  },
});
