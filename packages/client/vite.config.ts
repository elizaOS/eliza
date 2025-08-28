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
      // Prevent node Sentry code from entering the browser bundle
      '@sentry/node': path.resolve(__dirname, './src/mocks/empty-module.ts'),
      '@sentry/node-core': path.resolve(__dirname, './src/mocks/empty-module.ts'),
      'node:util': path.resolve(__dirname, './src/mocks/empty-module.ts'),
      'diagnostics_channel': path.resolve(__dirname, './src/mocks/empty-module.ts'),
      'node:diagnostics_channel': path.resolve(__dirname, './src/mocks/empty-module.ts'),
      'worker_threads': path.resolve(__dirname, './src/mocks/empty-module.ts'),
      // Fallback mock for rare usages
      'node:module': path.resolve(__dirname, './src/mocks/node-module.ts'),
      module: path.resolve(__dirname, './src/mocks/node-module.ts'),
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
    // Force optimization even for linked packages
    force: true,
    // Ensure elizaos/core is pre-bundled with polyfills
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
    'process.env': {},
    global: 'globalThis',
  },
});
