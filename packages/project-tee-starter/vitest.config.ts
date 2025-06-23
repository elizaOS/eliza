import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    exclude: ['e2e/**/*.test.ts', 'node_modules/**/*'],
    environment: 'node',
  },
});