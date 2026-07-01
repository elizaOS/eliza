import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle for CI image builds (#9300): emits
  // .next/standalone with a minimal server.js + traced node_modules, so the
  // showcase Docker image ships without a full `bun install` in-image. The
  // standalone server lands under the outputFileTracingRoot-relative path
  // (.next/standalone/packages/examples/cloud/clone-ur-crush/server.js).
  output: "standalone",
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  outputFileTracingRoot: path.join(__dirname, "../../../.."),
  images: {
    domains: ["localhost"],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
  env: {
    NEXT_PUBLIC_ELIZA_CLOUD_URL:
      process.env.NEXT_PUBLIC_ELIZA_CLOUD_URL || "https://elizacloud.ai",
  },
};

export default nextConfig;
