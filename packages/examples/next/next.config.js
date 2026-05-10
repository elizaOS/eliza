import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const distDir = process.env.NEXT_DIST_DIR;

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(distDir ? { distDir } : {}),
  outputFileTracingRoot: __dirname,
  transpilePackages: ["@electric-sql/pglite-react"],
  // Exclude PGLite from server-side bundling to preserve file paths for extensions
  serverExternalPackages: [
    "@electric-sql/pglite",
    "@elizaos/core",
    "@elizaos/plugin-openai",
    "@elizaos/plugin-sql",
    "zlib-sync",
  ],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.resolve = config.resolve ?? {};
      config.resolve.alias = {
        ...config.resolve.alias,
        "zlib-sync": require.resolve("zlib-sync"),
      };

      config.ignoreWarnings = [
        ...(config.ignoreWarnings || []),
        {
          module: /core[/\\]dist[/\\]node[/\\]index\.node\.js/,
          message: /Critical dependency/,
        },
      ];

      // Don't bundle PGLite extension files as assets
      config.externals = config.externals || [];
      config.externals.push({
        "@electric-sql/pglite": "commonjs @electric-sql/pglite",
        "@electric-sql/pglite/vector": "commonjs @electric-sql/pglite/vector",
        "@electric-sql/pglite/contrib/fuzzystrmatch":
          "commonjs @electric-sql/pglite/contrib/fuzzystrmatch",
      });
    }
    return config;
  },
};

export default nextConfig;
