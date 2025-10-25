import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
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
      // Include sourcemaps for dependencies during development to improve stack traces
      sourcemapIgnoreList: false,
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
        // Prevent node Sentry code from entering the browser bundle
        '@sentry/node': path.resolve(__dirname, './src/mocks/empty-module.ts'),
        '@sentry/node-core': path.resolve(__dirname, './src/mocks/empty-module.ts'),
      },
      // Ensure a single React instance to avoid "older version of React" element errors
      dedupe: ['react', 'react-dom'],
    },
    optimizeDeps: {
      esbuildOptions: {
        // Generate sourcemaps for pre-bundled deps to unminify vendor stack traces
        sourcemap: true,
        keepNames: true,
        define: {
          global: 'globalThis',
        },
      },
      entries: ['./src/entry.tsx'],
      include: ['buffer', 'process', '@elizaos/core', '@elizaos/api-client'],
    },
    build: {
      target: 'esnext',
      // Enable full sourcemaps in production builds for better error stacks
      sourcemap: true,
      reportCompressedSize: false,
      minify: 'esbuild',
      chunkSizeWarningLimit: 2200, // Increase chunk size warning limit to accommodate large chunks
      cssMinify: false, // Disable CSS minification to avoid :is() syntax errors in webkit scrollbar styles
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
    // Preserve function/class names to improve stack trace readability
    esbuild: {
      keepNames: true,
    },
    define: {
      // Define globals for browser compatibility
      'process.env': JSON.stringify({}),
      'process.browser': true,
      global: 'globalThis',
    },
  };
});
