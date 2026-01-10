import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 60000,
    exclude: [
      '**/e2e/**', 
      '**/node_modules/**',
      'plugin-*/**', // Exclude tests from plugin subdirectories
      '**/dist/**'   // Exclude built files
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
