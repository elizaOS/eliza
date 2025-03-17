import path from 'node:path';
import react from '@vitejs/plugin-react-swc';
import { type Plugin, type UserConfig, defineConfig, loadEnv } from 'vite';
import viteCompression from 'vite-plugin-compression';

// https://vite.dev/config/
export default defineConfig(({ mode }): UserConfig => {
  const envDir = path.resolve(__dirname, '../..');
  const env = loadEnv(mode, envDir, '');

  return {
    plugins: [
      react() as unknown as Plugin,
      viteCompression({
        algorithm: 'brotliCompress',
        ext: '.br',
        threshold: 1024,
      }) as Plugin,
      // Custom plugin to filter out externalization warnings
      {
        name: 'filter-externalization-warnings',
        enforce: 'pre',
        configureServer(server) {
          const originalInfo = server.config.logger.info;
          server.config.logger.info = (msg) => {
            if (!msg.includes('has been externalized for browser compatibility')) {
              originalInfo(msg);
            }
          };
        },
      },
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
  };
});
