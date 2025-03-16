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
    },
    resolve: {
      alias: {
        '@': '/src',
      },
    },
  };
});
