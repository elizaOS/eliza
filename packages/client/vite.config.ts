import path from 'node:path';
import react from '@vitejs/plugin-react-swc';
import { type Plugin, type UserConfig, defineConfig, loadEnv } from 'vite';
import viteCompression from 'vite-plugin-compression';
import clientElizaLogger from './src/lib/logger';
// @ts-ignore:next-line
import type { InlineConfig } from 'vitest'; // Import Vitest config type
// @ts-ignore:next-line
import type { UserConfig as VitestUserConfigInterface } from 'vitest/config'; // Import Vitest config type for test property

// https://vite.dev/config/

// Combine Vite's UserConfig with Vitest's config for the 'test' property
interface CustomUserConfig extends UserConfig {
  test?: VitestUserConfigInterface['test'];
}

export default defineConfig(({ mode }): CustomUserConfig => {
  const envDir = path.resolve(__dirname, '../..');
  const env = loadEnv(mode, envDir, '');

  // Custom plugin to filter out externalization warnings
  const filterExternalizationWarnings: Plugin = {
    name: 'filter-externalization-warnings',
    apply: 'build', // Only apply during build
    configResolved(config) {
      const originalLogFn = config.logger.info;
      config.logger.info = (msg, options) => {
        if (
          typeof msg === 'string' &&
          msg.includes('has been externalized for browser compatibility')
        ) {
          return; // Suppress the warning
        }
        originalLogFn(msg, options);
        // Also log to our custom logger
        clientElizaLogger.info(msg, options);
      };
    },
  };

  return {
    plugins: [
      react() as unknown as Plugin,
      viteCompression({
        algorithm: 'brotliCompress',
        ext: '.br',
        threshold: 1024,
      }) as Plugin,
      filterExternalizationWarnings,
    ],
    clearScreen: false,
    envDir,
    define: {
      'import.meta.env.VITE_SERVER_PORT': JSON.stringify(env.SERVER_PORT || '3000'),
    },
    build: {
      outDir: 'dist',
      minify: false,
      cssMinify: true,
      sourcemap: true,
      cssCodeSplit: true,
      rollupOptions: {
        external: ['cloudflare:sockets'],
        onwarn(warning, warn) {
          // Suppress specific externalized warnings
          if (
            warning.code === 'UNRESOLVED_IMPORT' &&
            typeof warning.message === 'string' &&
            /node:|fs|path|crypto|stream|tty|worker_threads|assert/.test(warning.message)
          ) {
            return;
          }
          warn(warning);
          // Also log to our custom logger
          clientElizaLogger.warn(warning.message || 'Unknown warning');
        },
      },
    },
    resolve: {
      alias: {
        '@': '/src',
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
