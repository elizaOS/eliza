import path from 'node:path';
import react from '@vitejs/plugin-react-swc';
import { type Plugin, type UserConfig, defineConfig, loadEnv } from 'vite';
import viteCompression from 'vite-plugin-compression';

// https://vite.dev/config/
export default defineConfig(({ mode }): UserConfig => {
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
        },
      },
    },
    resolve: {
      alias: {
        '@': '/src',
      },
    },
    logLevel: 'error', // Only show errors, not warnings
  };
});
