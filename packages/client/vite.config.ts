import react from '@vitejs/plugin-react-swc';
import path from 'node:path';
import fs from 'node:fs';
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

// Function to get version and write info.json
const getVersionAndWriteInfo = () => {
  const lernaPath = path.resolve(__dirname, '../../lerna.json');
  const packageJsonPath = path.resolve(__dirname, '../../package.json');
  const infoJsonDir = path.resolve(__dirname, 'src/lib');
  const infoJsonPath = path.resolve(infoJsonDir, 'info.json');
  let version = '0.0.0-error'; // Default/fallback version

  try {
    // First try to get version from lerna.json
    if (fs.existsSync(lernaPath)) {
      const lernaContent = fs.readFileSync(lernaPath, 'utf-8');
      const lernaConfig = JSON.parse(lernaContent);
      version = lernaConfig.version || version;
    } else {
      console.warn(`Warning: ${lernaPath} does not exist. Trying package.json...`);

      // Fallback to main package.json if lerna.json doesn't exist
      if (fs.existsSync(packageJsonPath)) {
        const packageContent = fs.readFileSync(packageJsonPath, 'utf-8');
        const packageConfig = JSON.parse(packageContent);
        version = packageConfig.version || version;
      }
    }

    if (!fs.existsSync(infoJsonDir)) {
      fs.mkdirSync(infoJsonDir, { recursive: true });
    }
    fs.writeFileSync(infoJsonPath, JSON.stringify({ version }));
    console.log(`Version ${version} written to ${infoJsonPath}`);
    return version;
  } catch (error) {
    console.error('Error processing version:', error);
    // Attempt to write info.json even if there was an error reading lerna.json
    if (!fs.existsSync(infoJsonDir)) {
      fs.mkdirSync(infoJsonDir, { recursive: true });
    }
    fs.writeFileSync(infoJsonPath, JSON.stringify({ version })); // Writes the fallback version
    console.warn(`Fallback version ${version} written to ${infoJsonPath} due to error.`);
    return version;
  }
};

// Custom plugin to generate version info
const versionPlugin = (): Plugin => {
  let appVersion: string;
  return {
    name: 'eliza-version-plugin',
    // config hook runs before server starts and build
    config: () => {
      appVersion = getVersionAndWriteInfo();
      return {
        define: {
          'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
        },
      };
    },
    // buildStart is good too, but config ensures define is set early
    // buildStart: () => {
    //   getVersionAndWriteInfo();
    // },
  };
};

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
      versionPlugin(),
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
    logLevel: mode === 'development' ? 'info' : 'error',
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
