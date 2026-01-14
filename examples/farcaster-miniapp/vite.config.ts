import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react()],
    // Prevent duplicate React copies in monorepo test/build (fixes "Invalid hook call")
    resolve: {
        dedupe: ['react', 'react-dom'],
    },
    server: {
        port: 3000,
        proxy: {
            '/api': {
                target: 'http://localhost:3001',
                changeOrigin: true,
            },
        },
    },
    test: {
        environment: 'jsdom',
        setupFiles: ['./__tests__/setup.ts'],
        globals: true,
        clearMocks: true,
        restoreMocks: true,
    },
})

