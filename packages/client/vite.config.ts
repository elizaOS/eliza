import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'node:path';
// @ts-ignore
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss() as unknown as PluginOption,
    react() as unknown as PluginOption,
  ],
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    // Reduce watcher pressure to avoid EMFILE on large workspaces
    watch: {
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/.turbo/**',
        '**/dist/**',
        '**/coverage/**',
        'cypress/screenshots/**',
        'cypress/videos/**',
      ],
      usePolling: true,
      interval: 150,
    },
    // Restrict file serving and watching outside the client and core source
    fs: {
      strict: true,
      allow: [
        path.resolve(__dirname, './'),
        path.resolve(__dirname, '../core/src'),
      ],
    },
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Use core source during dev to avoid requiring a build step
      '@elizaos/core': path.resolve(__dirname, '../core/src/index.ts'),
      // Prevent node Sentry code from entering the browser bundle
      '@sentry/node': path.resolve(__dirname, './src/mocks/empty-module.ts'),
      '@sentry/node-core': path.resolve(__dirname, './src/mocks/empty-module.ts'),
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
    force: true,
    entries: ['./src/entry.tsx'],
  },
  build: {
    target: 'esnext',
    sourcemap: false,
    reportCompressedSize: false,
    minify: 'esbuild',
    rollupOptions: {
      external: [],
    },
    commonjsOptions: {
      transformMixedEsModules: true,
      ignoreTryCatch: false,
    },
  },
  define: {
    // Define globals for browser compatibility
    'process.env': JSON.stringify({}),
    'process.browser': true,
    global: 'globalThis',
  },
});
