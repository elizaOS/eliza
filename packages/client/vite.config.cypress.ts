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
  // resources that accumulate across 25+ spec files in CI.
  server: {
    hmr: false, // No hot-reload needed for isolated component tests
    watch: {
      // Reduce file-watcher pressure in CI
      ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/cypress/screenshots/**'],
    },
    // Pre-warm the support file so it's already transformed and cached when
    // Cypress dynamically imports it between spec transitions.  This is the
    // exact module that fails to load under resource pressure.
    warmup: {
      clientFiles: ['cypress/support/component.ts'],
    },
  },
  // Disable sourcemaps for component tests to reduce memory consumption.
  // The Vite dev-server runs all 25+ specs in a single process; source maps
  // for every dependency accumulate and can push the process past the
  // default V8 heap limit on CI runners with constrained memory.
  css: { devSourcemap: false },
  build: { sourcemap: false },
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
      // Disable sourcemaps during pre-bundling to reduce memory pressure.
      // Under CI, the cumulative cost of sourcemaps across 80+ pre-bundled
      // packages can exhaust the V8 heap after ~20 spec transitions.
      sourcemap: false,
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
      // Every @radix-ui package used by component tests MUST be listed here.
      // Missing entries cause on-demand bundling mid-run, which accumulates
      // memory pressure and leads to the "Failed to fetch dynamically imported
      // module" crash around spec 20+.
      '@radix-ui/react-alert-dialog',
      '@radix-ui/react-avatar',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-collapsible',
      '@radix-ui/react-dialog',
      '@radix-ui/react-direction',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-label',
      '@radix-ui/react-scroll-area',
      '@radix-ui/react-select',
      '@radix-ui/react-separator',
      '@radix-ui/react-slot',
      '@radix-ui/react-switch',
      '@radix-ui/react-tabs',
      '@radix-ui/react-toast',
      '@radix-ui/react-tooltip',
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
