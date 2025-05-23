import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/e2e/**', '**/dist/**', '**/node_modules/**'],
    coverage: {
      reporter: ['text', 'json', 'html'],
    },
  },
});
