import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['**/e2e/**', '**/dist/**', '**/node_modules/**'],
    coverage: {
      reporter: ['text', 'json', 'html'],
    },
  },
});
