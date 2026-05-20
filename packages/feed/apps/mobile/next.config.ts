import type { NextConfig } from 'next';
import * as path from 'path';

const webSrc = path.resolve(__dirname, '../web/src');

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  distDir: 'out',
  images: {
    loader: 'custom',
    loaderFile: './src/lib/image-loader.ts',
  },
  transpilePackages: ['@babylon/shared', '@babylon/core', '@babylon/contracts'],
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  webpack: (config, { isServer, webpack }) => {
    // Resolve @/ imports to the web app's src directory for shared code
    config.resolve.alias = {
      ...config.resolve.alias,
      '@/components': path.join(webSrc, 'components'),
      '@/hooks': path.join(webSrc, 'hooks'),
      '@/stores': path.join(webSrc, 'stores'),
      '@/utils': path.join(webSrc, 'utils'),
      '@/contexts': path.join(webSrc, 'contexts'),
      '@/lib': path.join(webSrc, 'lib'),
      '@/types': path.join(webSrc, 'types'),
      // @web/ is an explicit alias for importing web app page components
      // from mobile pages. NOT @/app/ because that would make Next.js
      // discover web's pages as mobile routes.
      '@web': webSrc,
      // @/mobile resolves to mobile's own src directory
      '@/mobile': path.join(__dirname, 'src'),
    };

    // Enable WebAssembly experiments (for tiktoken if needed)
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };

    // Stub out Node.js built-ins for client builds (Privy SDK pulls in WalletConnect)
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        dns: false,
        crypto: false,
        stream: false,
        path: false,
        os: false,
        http: false,
        https: false,
        zlib: false,
        url: false,
        util: false,
        assert: false,
        buffer: false,
        events: false,
        'node:fs': false,
        'node:fs/promises': false,
        'node:path': false,
        'node:os': false,
        'node:crypto': false,
        'node:stream': false,
        'node:util': false,
        'node:url': false,
        'node:net': false,
        'node:tls': false,
        'node:dns': false,
        'node:buffer': false,
        'node:events': false,
        'node:http': false,
        'node:https': false,
        'node:zlib': false,
        'node:assert': false,
        'node:process': false,
        'node:perf_hooks': false,
        perf_hooks: false,
        child_process: false,
        worker_threads: false,
        electron: false,
        '@react-native-async-storage/async-storage': false,
      };

      // Ignore server-only packages in client builds
      config.plugins.push(
        new webpack.IgnorePlugin({
          resourceRegExp: /^@babylon\/(api|db|engine|training|agents)(\/.*)?$/,
        }),
        new webpack.IgnorePlugin({
          resourceRegExp:
            /^(ioredis|postgres|electron-fetch|agent0-sdk|ipfs-http-client|swagger-jsdoc)$/,
        }),
        new webpack.IgnorePlugin({
          resourceRegExp: /^@elizaos\/core$/,
        }),
        new webpack.IgnorePlugin({
          resourceRegExp: /^server-only$/,
        })
      );
    }

    return config;
  },
};

export default nextConfig;
