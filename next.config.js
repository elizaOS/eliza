/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  env: {
    XMRT_AGENT_ID: process.env.XMRT_AGENT_ID,
    XMRT_SUPABASE_URL: process.env.XMRT_SUPABASE_URL,
    XMRT_ECOSYSTEM_URL: process.env.XMRT_ECOSYSTEM_URL,
    XMRT_SUITE_AI_URL: process.env.XMRT_SUITE_AI_URL,
  },
}

module.exports = nextConfig