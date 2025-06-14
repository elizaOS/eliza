import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.vite/**',
        '**/.next/**',
        '**/.vercel/**',
        '**/coverage/**',
        '**/test/**',
        '**/test.{ts,js}',
        '**/tests/**',
        '**/tests.{ts,js}',
        '**/__tests__/**',
        '**/__tests__.{ts,js}',
        '**/*.d.ts',
        '**/*.config.{ts,js}',
        '**/*.setup.{ts,js}',
        'src/socketio/**', // Exclude socket.io for now - complex integration
        'src/authMiddleware.ts', // Simple middleware, covered by integration tests
        'src/loader.ts', // File I/O heavy, covered by integration tests
        'src/bus.ts', // Simple event bus
        'src/types.ts', // Type definitions only
        'src/upload.ts', // File upload handling, covered by integration tests
      ],
    },
    setupFiles: ['./test/setup.ts'],
    alias: {
      '@/src': path.resolve(__dirname, 'src'),
    },
    include: ['test/**/*.test.ts', 'test/**/*.spec.ts'],
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 4, // Adjust based on available cores
        isolate: false, // Improves performance by not isolating each test file
      },
    },
    // reporters: ['verbose'], // Enable verbose reporting for more details if needed
  },
});
