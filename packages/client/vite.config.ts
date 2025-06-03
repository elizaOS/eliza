import react from '@vitejs/plugin-react-swc';
import path from 'node:path';
import { type Plugin, type UserConfig, defineConfig, loadEnv } from 'vite';
import viteCompression from 'vite-plugin-compression';
import tailwindcss from '@tailwindcss/vite';
// @ts-ignore:next-line
// @ts-ignore:next-line
import type { ViteUserConfig } from 'vitest/config'; // Import Vitest config type for test property
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// https://vite.dev/config/

// Combine Vite's UserConfig with Vitest's config for the 'test' property
interface CustomUserConfig extends UserConfig {
  test?: ViteUserConfig['test'];
}

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

  return {
    plugins: [
      tailwindcss(),
      react() as unknown as Plugin,
      nodePolyfills() as unknown as Plugin,
      viteCompression({
        algorithm: 'brotliCompress',
        ext: '.br',
        threshold: 1024,
      }) as Plugin,
      filterWarnings,
    ],
    clearScreen: false,
    envDir,
    define: {
      'import.meta.env.VITE_SERVER_PORT': JSON.stringify(env.SERVER_PORT || '3000'),
      // Add empty shims for Node.js globals
      global: 'globalThis',
    },
    optimizeDeps: {
      esbuildOptions: {
        define: {
          global: 'globalThis',
        },
      },
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
        '@elizaos/core': path.resolve(__dirname, '../core/src/index.ts'),
      },
    },
    logLevel: 'error', // Only show errors, not warnings
    // Add Vitest configuration
    test: {
      globals: true, // Or false, depending on your preference
      environment: 'jsdom', // Or 'happy-dom', 'node'
      include: ['src/**/*.{test,spec}.{js,ts,jsx,tsx}'],
      exclude: [
        'src/tests/**/*.{test,spec}.{js,ts,jsx,tsx}', // Exclude Playwright tests
        'node_modules/**',
        'dist/**',
        'cypress/**',
        '**/*.d.ts',
        '{playwright,vite,vitest}.config.{js,ts,jsx,tsx}',
      ],
      // You might have other Vitest specific configurations here
      // setupFiles: './src/setupTests.ts', // if you have a setup file
    },
  };
});
