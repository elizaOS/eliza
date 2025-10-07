import react from '@vitejs/plugin-react-swc';
import path from 'node:path';
import { defineConfig, type PluginOption } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import inject from '@rollup/plugin-inject';

export default defineConfig({
  plugins: [
    tailwindcss() as unknown as PluginOption,
    react() as unknown as PluginOption,
    // Minimal shims for tests without pulling full node polyfills
    inject({
      modules: {
        Buffer: ['buffer', 'Buffer'],
        process: ['process', 'default'],
      },
    }) as unknown as PluginOption,
  ],
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
    esbuildOptions: {
      // Better stack traces in component tests
      sourcemap: true,
      keepNames: true,
      define: {
        global: 'globalThis',
      },
    },
    include: ['buffer', 'process'],
  },
  esbuild: {
    keepNames: true,
  },
});
