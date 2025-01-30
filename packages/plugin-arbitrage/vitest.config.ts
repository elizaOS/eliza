import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        setupFiles: ['./__tests__/setup.ts'],
        include: ['__tests__/**/*.test.ts'],
        coverage: {
            reporter: ['text', 'json', 'html'],
            include: ['src/**/*.ts'],
            exclude: ['**/*.d.ts', '**/*.test.ts']
        }
    },
    resolve: {
        alias: {
            '@elizaos/core': '/packages/core/src'
        }
    }
});
