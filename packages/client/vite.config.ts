import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'node:path';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
// @ts-ignore
import tailwindcss from '@tailwindcss/vite';
// Inject Buffer/process automatically into modules that reference them during build
import inject from '@rollup/plugin-inject';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // Keep node polyfills first so globals are injected early in the graph
    nodePolyfills({
      include: ['buffer', 'process', 'util', 'crypto', 'stream', 'events'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      overrides: {
        crypto: 'crypto-browserify',
        module: path.resolve(__dirname, './src/mocks/node-module.ts'),
      },
      protocolImports: false,
    }) as unknown as PluginOption,
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
      // Node shims used by some dependencies
      buffer: 'buffer',
      crypto: 'crypto-browserify',
      stream: 'stream-browserify',
      process: 'process/browser',
      util: 'util',
      events: 'events',
      // Fallback mock for rare usages
      'node:module': path.resolve(__dirname, './src/mocks/node-module.ts'),
      module: path.resolve(__dirname, './src/mocks/node-module.ts'),
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      // Node.js global compatibility
      define: {
        global: 'globalThis',
        Buffer: 'globalThis.Buffer',
      },
      // Inject polyfills early
      inject: [path.resolve(__dirname, './src/polyfills.ts')],
    },
    include: ['buffer', 'process', 'crypto-browserify', 'stream-browserify', 'util'],
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
      // Ensure modules are bundled correctly
      external: [],
      plugins: [
        // Ensure Buffer and process are available in any module that references them
        inject({
          Buffer: ['buffer', 'Buffer'],
          process: 'process',
        }) as unknown as PluginOption,
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
    global: 'globalThis',
    // Ensure Buffer is available globally
    Buffer: 'globalThis.Buffer',
  },
});
