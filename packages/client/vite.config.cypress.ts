import react from '@vitejs/plugin-react-swc';
import path from 'node:path';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    nodePolyfills({
      // Configure polyfills to work properly in browser
      protocolImports: false,
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      overrides: {
        // Make sure crypto uses the browser version
        crypto: 'crypto-browserify',
      },
      // Include specific modules that need polyfilling
      include: [
        'buffer',
        'crypto',
        'stream',
        'util',
        'process',
        'events',
        'path',
        'punycode',
        'querystring',
        'string_decoder',
        'url',
        'fs',
        'http',
        'https',
        'os',
        'assert',
        'constants',
        'timers',
        'console',
        'vm',
        'zlib',
        'tty',
        'domain',
      ],
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@elizaos/core': path.resolve(__dirname, '../core/src/index.ts'),
      // Explicit polyfill aliases
      crypto: 'crypto-browserify',
      stream: 'stream-browserify',
      buffer: 'buffer',
      process: 'process/browser',
      assert: 'assert',
      http: 'stream-http',
      https: 'https-browserify',
      os: 'os-browserify',
      url: 'url',
      util: 'util',
    },
  },
  define: {
    global: 'globalThis',
    'process.env': JSON.stringify({}),
    'process.browser': true,
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
    include: ['buffer', 'process', 'crypto-browserify', 'stream-browserify', 'util'],
  },
});
