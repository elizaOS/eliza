import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  resolve: {
    alias: {
      buffer: 'buffer',
      stream: 'stream-browserify',
      crypto: 'crypto-browserify',
      // Stub Node.js modules for browser compatibility
      'fs/promises': 'rollup-plugin-node-builtins',
      fs: 'rollup-plugin-node-builtins',
      path: 'path-browserify',
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
    exclude: ['@elizaos/plugin-auto-trader'],
  },
  build: {
    rollupOptions: {
      external: [
        'technicalindicators',
        'assert',
        'url',
        'http',
        'https',
        'http2',
        'util',
        'zlib',
        'events',
        'stream',
        'net',
        'tls',
        'fs',
        'fs/promises',
        'path',
        'node:async_hooks',
        'vm',
        '@elizaos/plugin-auto-trader',
        '@elizaos/plugin-trajectory-logger',
      ],
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});
