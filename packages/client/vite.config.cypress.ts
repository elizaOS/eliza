import react from '@vitejs/plugin-react-swc';
import path from 'node:path';
import { defineConfig, type PluginOption } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import inject from '@rollup/plugin-inject';

export default defineConfig({
  // Type assertions needed because plugin types may not exactly match PluginOption but are compatible
  plugins: [
    tailwindcss() as PluginOption,
    react() as PluginOption,
    // Minimal shims for tests without pulling full node polyfills
    inject({
      modules: {
        Buffer: ['buffer', 'Buffer'],
        process: ['process', 'default'],
      },
    }) as PluginOption,
  ],
  // Stabilise the Vite dev-server that Cypress spins up for component tests.
  // Without these settings the server can become unresponsive between spec
  // transitions, causing "Failed to fetch dynamically imported module" errors
  // for the support file.  This happens because HMR + file-watchers consume
  // resources that accumulate across 25 spec files in CI.
  server: {
    hmr: false, // No hot-reload needed for isolated component tests
    watch: {
      // Reduce file-watcher pressure in CI
      ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/cypress/screenshots/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Keep only what is actually used by tests
      buffer: 'buffer',
      process: 'process/browser',
    },
    dedupe: ['react', 'react-dom'],
  },
  define: {
    global: 'globalThis',
    'process.env': JSON.stringify({}),
    'process.browser': true,
  },
  optimizeDeps: {
    // Force Vite to pre-bundle ALL deps up front so it doesn't need to
    // re-process them between spec transitions (the primary cause of
    // "Failed to fetch dynamically imported module" in CI).
    force: true,
    esbuildOptions: {
      sourcemap: true,
      keepNames: true,
      define: {
        global: 'globalThis',
      },
    },
    include: [
      'buffer',
      'process',
      '@elizaos/core',
      '@elizaos/api-client',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-direction',
      '@radix-ui/react-tooltip',
      '@radix-ui/react-dialog',
      '@radix-ui/react-toast',
      '@radix-ui/react-avatar',
      '@radix-ui/react-select',
      '@radix-ui/react-scroll-area',
      '@radix-ui/react-collapsible',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-label',
      '@radix-ui/react-separator',
      '@radix-ui/react-tabs',
      'react',
      'react-dom',
      'react-dom/client',
      'react-router-dom',
      '@tanstack/react-query',
      '@cypress/react',
    ],
  },
  esbuild: {
    keepNames: true,
  },
});
