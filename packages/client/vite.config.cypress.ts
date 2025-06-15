import react from '@vitejs/plugin-react-swc';
import path from 'node:path';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    nodePolyfills({
      // Enable all polyfills for testing
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      // Enable all protocol imports
      protocolImports: true,
      // Include specific modules that need polyfilling
      include: [
        'buffer',
        'crypto',
        'stream',
        'util',
        'process',
        'events',
        'path',
        'punycode',
        'querystring',
        'string_decoder',
        'url',
        'fs',
        'http',
        'https',
        'os',
        'assert',
        'constants',
        'timers',
        'console',
        'vm',
        'zlib',
        'tty',
        'domain'
      ]
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@elizaos/core': path.resolve(__dirname, '../core/src/index.ts'),
      // Explicit polyfill aliases
      crypto: 'crypto-browserify',
      stream: 'stream-browserify',
      assert: 'assert',
      http: 'stream-http',
      https: 'https-browserify',
      os: 'os-browserify',
      url: 'url',
      util: 'util',
    },
  },
  define: {
    global: 'globalThis',
    'process.env': JSON.stringify({}),
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
    include: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-toast',
      '@radix-ui/react-tooltip',
      '@radix-ui/react-alert-dialog',
      'lucide-react',
      'buffer',
      'process',
      'crypto-browserify',
      'stream-browserify',
      'browserify-sign',
      'js-sha1',
      'js-sha256',
      'create-hash',
      'create-hmac',
      'randomfill',
      'randombytes',
      'pbkdf2',
      'cipher-base',
      'des.js',
      'md5.js',
      'diffie-hellman',
      'bn.js',
      'miller-rabin',
      'elliptic',
      'public-encrypt',
      'browserify-aes',
      'evp_bytestokey',
      'browserify-des',
      'browserify-cipher',
      'parse-asn1',
      'asn1.js',
      'safe-buffer',
      'readable-stream'
    ],
  },
}); 