import * as path from "node:path";
import { config } from "dotenv";
import type { NextConfig } from "next";

// Use process.cwd() which works reliably in Next.js config context
// This is the app directory (apps/web), so go up two levels to get monorepo root
const monorepoRoot = path.resolve(process.cwd(), "../..");

// Capture any Sentry auth token explicitly provided by the environment before dotenv runs.
// We intentionally ignore tokens sourced from local `.env` files to avoid stale/invalid tokens
// breaking developer builds when CI is set in the environment (common in some shells/CI runners).
const sentryAuthTokenFromProcessEnv = process.env.SENTRY_AUTH_TOKEN;

// Load .env files from monorepo root before Next.js processes them
// This ensures env vars are available during config evaluation and at runtime
config({ path: path.join(monorepoRoot, ".env") });
config({ path: path.join(monorepoRoot, ".env.local") });

const waitlistFlag =
  process.env.WAITLIST_MODE ?? process.env.NEXT_PUBLIC_WAITLIST_MODE ?? "false";
const waitlistEnabled = ["true", "1", "yes", "on"].includes(
  waitlistFlag.toLowerCase(),
);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Specify workspace root for monorepo
  outputFileTracingRoot: monorepoRoot,
  // Use standalone output for dynamic routes and API endpoints
  // Temporarily disabled for Next.js 16 compatibility
  // output: 'standalone',
  // Transpile internal workspace packages to resolve TypeScript imports properly
  // This is necessary because these packages are not pre-built and use TypeScript source directly
  transpilePackages: [
    "@babylon/shared",
    "@babylon/agents",
    "@babylon/api",
    "@babylon/db",
    "@babylon/contracts",
  ],
  experimental: {
    optimizePackageImports: ["lucide-react"],
    // instrumentationHook removed - available by default in Next.js 15+
  },
  typescript: {
    // Ignore type errors during build - we run typecheck separately via turbo
    ignoreBuildErrors: true,
  },
  env: {
    WAITLIST_MODE: process.env.WAITLIST_MODE ?? "false",
  },
  async redirects() {
    if (!waitlistEnabled) return [];

    return [
      {
        // Redirect everything except root and static/API assets to home during waitlist
        source:
          "/:path((?!$|_next|api|assets|static|images|fonts|favicon\\.ico|robots\\.txt|sitemap\\.xml|manifest\\.webmanifest|\\.well-known|monitoring).*)",
        destination: "/",
        permanent: false,
      },
    ];
  },
  // Skip prerendering for feed page (client-side only)
  skipTrailingSlashRedirect: true,
  // Farcaster Mini App manifest serving
  async rewrites() {
    return [
      {
        source: "/.well-known/farcaster.json",
        destination: "/farcaster.json",
      },
      {
        source: "/.well-known/agent-card.json",
        destination: "/api/game/card",
      },
    ];
  },
  // Externalize packages with native Node.js dependencies for server-side
  // Note: @babylon/* packages are in transpilePackages, so they can't be here
  serverExternalPackages: [
    "ipfs-http-client",
    "@helia/unixfs",
    "helia",
    "blockstore-core",
    "datastore-core",
    "@libp2p/interface",
    "electron-fetch",
    "swagger-jsdoc",
    "postgres",
    "drizzle-orm",
    "drizzle-orm/postgres-js",
    "ioredis", // Node.js Redis client - requires tls/net modules not available in edge runtime
    // NOTE: @elizaos/core was removed from externals because it's ESM-only ("type": "module").
    // Externalizing ESM packages causes require() errors at Vercel runtime (ERR_REQUIRE_ESM).
    // Webpack now bundles it directly which resolves the ESM compatibility issue.
  ],
  images: {
    qualities: [100, 75],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.public.blob.vercel-storage.com",
        pathname: "/**",
      },
      {
        protocol: "http",
        hostname: "localhost",
        port: "9000",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
  // Turbopack config for monorepo
  // Explicitly set root to suppress Next.js warning about multiple lockfiles.
  // The monorepo root contains the main bun.lock at /Users/shawwalters/babylon/bun.lock.
  // Nested packages (apps/docs, packages/examples) may have their own lockfiles, but this
  // is the correct root for the web app's workspace.
  turbopack: {
    root: monorepoRoot,
  },
  // Webpack configuration for backward compatibility
  webpack: (config, { isServer, webpack }) => {
    // Enable WebAssembly experiments for tiktoken
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    // Fix for IPFS, electron-fetch, and React Native dependencies
    // Also handle Node.js built-ins that server-only packages require
    config.resolve.fallback = {
      ...config.resolve.fallback,
      electron: false,
      fs: false,
      "node:fs": false,
      "node:fs/promises": false,
      "node:path": false,
      "node:os": false,
      "node:crypto": false,
      "node:stream": false,
      "node:util": false,
      "node:url": false,
      "node:net": false,
      "node:tls": false,
      "node:dns": false,
      "node:perf_hooks": false,
      net: false,
      tls: false,
      dns: false,
      perf_hooks: false,
      path: false,
      crypto: false,
      stream: false,
      util: false,
      url: false,
      os: false,
      "@react-native-async-storage/async-storage": false,
    };

    // Alias electron to stub module to prevent webpack from trying to resolve it
    // electron-fetch checks process.versions.electron at runtime, so the stub is safe
    const electronStubPath = path.join(
      process.cwd(),
      "webpack-electron-stub.js",
    );
    config.resolve.alias = {
      ...config.resolve.alias,
      electron: electronStubPath,
      // Redirect @solana/web3.js to @solana/kit for Solana Kit API compatibility
      // This is needed because @solana-program packages expect Solana Kit API
      "@solana/web3.js": "@solana/kit",
    };

    // Ignore electron module completely - electron-fetch will handle it at runtime
    // This prevents webpack from trying to resolve electron during bundling
    const electronFetchStubPath = path.join(
      process.cwd(),
      "webpack-electron-fetch-stub.js",
    );
    config.plugins = config.plugins || [];

    // Apply replacements early, before other plugins
    config.plugins.unshift(
      // Use NormalModuleReplacementPlugin to replace electron with our stub
      // This is more reliable than IgnorePlugin for this case
      new webpack.NormalModuleReplacementPlugin(/^electron$/, electronStubPath),
      // Replace electron-fetch with our stub to prevent electron dependency
      // electron-fetch checks process.versions.electron at runtime anyway
      new webpack.NormalModuleReplacementPlugin(
        /^electron-fetch$/,
        electronFetchStubPath,
      ),
    );

    // Also use IgnorePlugin as a fallback for any remaining cases
    // CRITICAL: For client builds, completely ignore server-only packages
    if (!isServer) {
      config.plugins.push(
        // Ignore server-only Babylon packages in client builds
        new webpack.IgnorePlugin({
          resourceRegExp: /^@babylon\/(api|db|contracts|agents)$/,
        }),
        // Ignore server-only npm packages
        new webpack.IgnorePlugin({
          resourceRegExp:
            /^(ioredis|postgres|electron-fetch|agent0-sdk|ipfs-http-client)$/,
        }),
        // Ignore @elizaos/core for client builds (it imports node:fs)
        new webpack.IgnorePlugin({
          resourceRegExp: /^@elizaos\/core$/,
        }),
      );
    }

    // Common plugins for both server and client
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^electron$/,
        contextRegExp: /node_modules/,
      }),
      // Ignore electron-fetch as a fallback if replacement doesn't work
      new webpack.IgnorePlugin({
        resourceRegExp: /^electron-fetch$/,
        contextRegExp: /node_modules/,
      }),
      // Ignore swagger-jsdoc - it's an optional dev dependency for docs generation
      // The code handles its absence gracefully, but webpack still tries to resolve it
      // Don't restrict to node_modules context since it might be imported from our packages
      new webpack.IgnorePlugin({
        resourceRegExp: /^swagger-jsdoc$/,
      }),
      // Ignore postgres package for client-side builds only
      // postgres requires Node.js built-ins (net, tls, crypto, stream) not available in browser
      ...(isServer
        ? []
        : [
            new webpack.IgnorePlugin({
              resourceRegExp: /^postgres$/,
              contextRegExp: /node_modules/,
            }),
          ]),
    );

    // Configure externals for optional dependencies and server-only packages
    // swagger-jsdoc is optional and handled gracefully in the code with try-catch
    // electron and electron-fetch need special handling to prevent bundling issues
    if (isServer) {
      // For server-side, ensure packages in serverExternalPackages are externalized
      // They're already in serverExternalPackages, but we also configure webpack
      // to externalize them so they're resolved at runtime from node_modules
      // NOTE: Do NOT externalize @babylon/* packages - they are TypeScript source files
      // and must be transpiled by webpack via transpilePackages
      // NOTE: @elizaos/core intentionally excluded - it's ESM-only and must be bundled
      const serverExternalPackagesList = [
        "postgres",
        "drizzle-orm",
        "drizzle-orm/postgres-js",
        "ioredis",
        "swagger-jsdoc",
      ];

      if (!Array.isArray(config.externals)) {
        if (typeof config.externals === "function") {
          const originalExternals = config.externals;
          config.externals = [
            originalExternals,
            (
              {
                request,
              }: {
                request: string | undefined;
              },
              callback: (error?: Error | null, result?: string) => void,
            ) => {
              if (
                request &&
                serverExternalPackagesList.some(
                  (pkg) => request === pkg || request.startsWith(`${pkg}/`),
                )
              ) {
                // Externalize server-only packages - resolve at runtime
                return callback(null, `commonjs ${request}`);
              }
              callback();
            },
          ];
        } else {
          config.externals = [];
        }
      }
      if (Array.isArray(config.externals)) {
        config.externals.push(
          (
            {
              request,
            }: {
              request: string | undefined;
            },
            callback: (error?: Error | null, result?: string) => void,
          ) => {
            if (
              request &&
              serverExternalPackagesList.some(
                (pkg) => request === pkg || request.startsWith(`${pkg}/`),
              )
            ) {
              // Externalize server-only packages - resolve at runtime
              return callback(null, `commonjs ${request}`);
            }
            callback();
          },
        );
      }
    } else {
      // Externalize agent0-sdk and related packages to prevent bundling electron-fetch
      // Also externalize postgres and Node.js-only packages
      // These should only be loaded server-side via dynamic imports
      // CRITICAL: Externalize @babylon/api and @babylon/db to prevent bundling server-only code in client
      const serverOnlyPackages = [
        "agent0-sdk",
        "@babylon/agents/agent0",
        "ipfs-http-client",
        "electron-fetch",
        "postgres",
        "ioredis",
        "@babylon/db",
        "@babylon/api",
        "@babylon/contracts",
        "swagger-jsdoc",
      ];

      const nodeBuiltIns = [
        "fs",
        "node:fs",
        "node:fs/promises",
        "net",
        "node:net",
        "tls",
        "node:tls",
        "dns",
        "node:dns",
        "path",
        "node:path",
        "crypto",
        "node:crypto",
        "stream",
        "node:stream",
        "util",
        "node:util",
        "url",
        "node:url",
        "os",
        "node:os",
        "perf_hooks",
        "node:perf_hooks",
        "electron",
      ];

      // Use function-based externals to catch all imports of server-only packages
      // Webpack externals function signature: ({context, request}, callback)
      const externalizeServerOnly = (
        { request }: { context?: string; request?: string },
        callback: (error?: Error | null, result?: string) => void,
      ) => {
        // Externalize server-only packages (exact match or subpath)
        if (
          request &&
          serverOnlyPackages.some(
            (pkg) => request === pkg || request.startsWith(`${pkg}/`),
          )
        ) {
          return callback(null, `commonjs ${request}`);
        }
        // Externalize Node.js built-ins
        if (request && nodeBuiltIns.includes(request)) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      };

      // Combine with existing externals
      if (Array.isArray(config.externals)) {
        config.externals.push(externalizeServerOnly);
      } else if (typeof config.externals === "function") {
        const originalExternals = config.externals;
        config.externals = [originalExternals, externalizeServerOnly];
      } else {
        config.externals = [config.externals, externalizeServerOnly].filter(
          Boolean,
        );
      }
    }

    // Ignore postgres package completely for client-side builds
    // postgres requires Node.js built-ins (net, tls, crypto, stream) not available in browser
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^postgres$/,
        contextRegExp: /node_modules/,
      }),
    );

    return config;
  },
};

// Only enable Sentry uploads in CI/Vercel builds.
// This prevents local builds from failing if a developer has a stale/invalid token set.
const sentryAuthToken =
  process.env.CI || process.env.VERCEL
    ? sentryAuthTokenFromProcessEnv
    : undefined;

const sentryWebpackPluginOptions = {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "symbaiex",

  project: "babylon",

  // Auth token for uploading source maps and creating releases
  // Set SENTRY_AUTH_TOKEN in environment to enable source map uploads
  authToken: sentryAuthToken,

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // Suppress warnings when auth token is not provided (e.g., local development)
  hideSourceMaps: !sentryAuthToken,

  // Disable telemetry to suppress warnings during build
  telemetry: false,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  // Automatically tree-shake Sentry logger statements to reduce bundle size
  disableLogger: true,

  // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
  // See the following for more information:
  // https://docs.sentry.io/product/crons/
  // https://vercel.com/docs/cron-jobs
  automaticVercelMonitors: true,
};

// Wrap Sentry config in async function to handle top-level await
async function getConfig(): Promise<NextConfig> {
  let resolvedConfig: NextConfig = nextConfig;

  // If we're not uploading sourcemaps/releases, don't wrap the config at all.
  // This prevents local builds from invoking Sentry CLI when a stale token is present.
  if (!sentryAuthToken) {
    return resolvedConfig;
  }

  try {
    const { withSentryConfig } = await import("@sentry/nextjs");
    resolvedConfig = withSentryConfig(nextConfig, sentryWebpackPluginOptions);
  } catch (error) {
    const shouldLog = process.env.CI || process.env.NODE_ENV !== "production";
    if (shouldLog) {
      console.warn(
        "[next.config.ts] Sentry integration disabled. Falling back to base config.",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return resolvedConfig;
}

export default getConfig();
