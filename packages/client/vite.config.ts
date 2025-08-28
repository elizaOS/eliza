import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'node:path';
// @ts-ignore
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const isDev = mode === 'development';
  const isBuild = command === 'build';

  return {
    plugins: [tailwindcss() as unknown as PluginOption, react() as unknown as PluginOption],
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
        // In dev mode, use source. In build/production, let Node resolution handle it
        ...(isDev
          ? {
              '@elizaos/core': path.resolve(__dirname, '../core/src/index.ts'),
            }
          : {}),
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
      entries: ['./src/entry.tsx'],
      include: ['buffer', 'process', '@elizaos/core', '@elizaos/api-client'],
    },
    build: {
      target: 'esnext',
      sourcemap: false,
      reportCompressedSize: false,
      minify: 'esbuild',
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
        },
        output: {
          manualChunks: (id) => {
            if (id.includes('node_modules')) {
              if (id.includes('react') || id.includes('react-dom') || id.includes('react-router')) {
                return 'react-vendor';
              }
              if (id.includes('@radix-ui')) {
                return 'ui-vendor';
              }
              if (id.includes('@elizaos')) {
                return 'elizaos-vendor';
              }
            }
          },
        },
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
  };
});
