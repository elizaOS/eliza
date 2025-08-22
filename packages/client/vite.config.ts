import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
// @ts-ignore
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    nodePolyfills({
      // Include specific Node.js polyfills
      include: ['crypto', 'stream', 'buffer', 'process', 'util', 'path', 'fs'],
      // Whether to polyfill specific globals
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      // Override specific module polyfills
      overrides: {
        // Override the module polyfill to provide createRequire
        module: path.resolve(__dirname, './src/mocks/node-module.ts'),
      },
    }),
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
      // Direct alias for node:module to our mock
      'node:module': path.resolve(__dirname, './src/mocks/node-module.ts'),
      // Also alias the plain module import
      'module': path.resolve(__dirname, './src/mocks/node-module.ts'),
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      // Node.js global compatibility
      define: {
        global: 'globalThis',
      },
      // Inject polyfills
      inject: [path.resolve(__dirname, './src/mocks/node-module.ts')],
    },
    include: [
      '@elizaos/core',
      'crypto-browserify',
      'stream-browserify',
      'buffer',
    ],
    // Force optimization even for linked packages
    force: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      // Ensure modules are bundled correctly
      external: [],
      plugins: [
        {
          name: 'node-module-polyfill',
          resolveId(source) {
            if (source === 'node:module') {
              return path.resolve(__dirname, './src/mocks/node-module.ts');
            }
            return null;
          },
        },
      ],
    },
    commonjsOptions: {
      transformMixedEsModules: true,
      ignoreTryCatch: false,
    },
  },
  define: {
    // Define globals for browser compatibility
    'process.env': {},
    'global': 'globalThis',
  },
})