import react from '@vitejs/plugin-react-swc';
import path from 'node:path';
import { type Plugin, type UserConfig, defineConfig, loadEnv } from 'vite';
import viteCompression from 'vite-plugin-compression';
import tailwindcss from '@tailwindcss/vite';
// @ts-ignore:next-line
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// https://vite.dev/config/

// Define custom config interface
interface CustomUserConfig extends UserConfig {}

export default defineConfig(({ mode }): CustomUserConfig => {
  const envDir = path.resolve(__dirname, '../..');
  const env = loadEnv(mode, envDir, '');

  // Custom plugin to filter out unnecessary warnings
  const filterWarnings: Plugin = {
    name: 'filter-warnings',
    apply: 'build', // Only apply during build
    configResolved(config) {
      const originalWarnFn = config.logger.warn;
      config.logger.warn = (msg, options) => {
        if (typeof msg !== 'string') return originalWarnFn(msg, options);
        if (msg.includes('has been externalized for browser compatibility')) {
          return;
        }
        originalWarnFn(msg, options);
      };
    },
  };

  // Custom plugin to inject CommonJS shims
  const injectCommonJSShims: Plugin = {
    name: 'inject-commonjs-shims',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'script',
            attrs: { type: 'module' },
            children: `
              // CommonJS shims for browser compatibility
              if (typeof window !== 'undefined') {
                window.global = window.global || window;
                window.exports = window.exports || {};
                window.module = window.module || { exports: {} };
              }
            `,
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };

  return {
    plugins: [
      injectCommonJSShims,
      tailwindcss(),
      react() as unknown as Plugin,
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
      }) as unknown as Plugin,
      viteCompression({
        algorithm: 'brotliCompress',
        ext: '.br',
        threshold: 1024,
      }) as Plugin,
      filterWarnings,
    ],
    clearScreen: false,
    envDir,
    server: {
      port: 5173,
      host: '0.0.0.0',
      strictPort: true,
      hmr: {
        port: 5174,
        host: '0.0.0.0',
      },
      watch: {
        usePolling: false,
        interval: 100,
      },
      cors: true,
      proxy: {
        // Proxy all API calls to backend server
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
          secure: false,
        },
        // Proxy WebSocket connections for real-time features
        '/socket.io': {
          target: 'http://localhost:3000',
          changeOrigin: true,
          ws: true,
        },
        // Proxy any other backend endpoints that might exist
        '/v1': {
          target: 'http://localhost:3000',
          changeOrigin: true,
          secure: false,
        },
        // Proxy health check and ping endpoints
        '/ping': {
          target: 'http://localhost:3000',
          changeOrigin: true,
          secure: false,
        },
        // Proxy any direct server endpoints
        '/server': {
          target: 'http://localhost:3000',
          changeOrigin: true,
          secure: false,
        },
      },
    },
    define: {
      'import.meta.env.VITE_SERVER_PORT': JSON.stringify(env.SERVER_PORT || '3000'),
      // Add shims for Node.js globals
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
    build: {
      target: 'esnext',
      outDir: 'dist',
      emptyOutDir: true,
      minify: false,
      cssMinify: true,
      sourcemap: true,
      rollupOptions: {
        external: ['cloudflare:sockets'],
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom', 'react-router-dom'],
            // Also chunk node_modules into vendor
            ...(id: string) => (id.includes('node_modules') ? { vendor: [id] } : undefined),
          },
        },
        onwarn(warning, warn) {
          // Suppress circular dependencies and externalized warnings
          if (
            warning.code === 'CIRCULAR_DEPENDENCY' ||
            (typeof warning.message === 'string' &&
              (warning.message.includes('has been externalized for browser compatibility') ||
                warning.message.includes("The 'this' keyword is equivalent to 'undefined'") ||
                warning.message.includes('unenv') ||
                /node:|fs|path|crypto|stream|tty|worker_threads|assert/.test(warning.message)))
          ) {
            return;
          }
          warn(warning);
        },
      },
    },
    resolve: {
      alias: {
        '@': '/src',
        '@elizaos/core': path.resolve(__dirname, '../core/dist/index.js'),
        // Add explicit aliases for problematic modules
        crypto: 'crypto-browserify',
        stream: 'stream-browserify',
        buffer: 'buffer',
        process: 'process/browser',
        util: 'util',
      },
    },
    logLevel: mode === 'development' ? 'info' : 'error',
  };
});
