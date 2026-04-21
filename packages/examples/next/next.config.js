/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@electric-sql/pglite-react"],
  // Exclude PGLite from server-side bundling to preserve file paths for extensions
  serverExternalPackages: ["@electric-sql/pglite"],
  webpack: (config, { isServer }) => {
    if (isServer) {
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
