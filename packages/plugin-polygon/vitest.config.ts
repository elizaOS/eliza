import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true, // Enable global API (describe, it, expect, etc.)
    environment: 'node',
    // Path is relative to this config file (packages/plugin-polygon/)
    setupFiles: [path.resolve(__dirname, 'vitest.setup.ts')],
    // Optional: increase test timeout for integration tests if needed
    // testTimeout: 30000,
  },
});
