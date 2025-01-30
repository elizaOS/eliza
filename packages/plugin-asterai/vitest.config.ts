import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['__tests__/**/*.test.ts'],
        mockReset: true,
        clearMocks: true,
        restoreMocks: true,
        reporters: ['default'],
        testTimeout: 10000
    },
});
