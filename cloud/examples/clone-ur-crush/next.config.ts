import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
    NEXT_PUBLIC_ELIZA_CLOUD_URL: process.env.NEXT_PUBLIC_ELIZA_CLOUD_URL || "http://localhost:3000",
    NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
    NEXT_PUBLIC_AFFILIATE_API_KEY: process.env.NEXT_PUBLIC_AFFILIATE_API_KEY,
  },
};

export default nextConfig;
