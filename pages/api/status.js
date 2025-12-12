export default function handler(req, res) {
  res.status(200).json({
    server: 'running',
    xmrt_integration: 'active',
    ecosystem_connections: {
      suite_ai: process.env.XMRT_SUITE_AI_URL || 'https://suite.lovable.app',
      ecosystem: process.env.XMRT_ECOSYSTEM_URL || 'https://xmrt-ecosystem.vercel.app',
      supabase: process.env.XMRT_SUPABASE_URL || 'https://vawouugtzwmejxqkeqqj.supabase.co'
    },
    deployment: 'vercel-nextjs',
    timestamp: new Date().toISOString()
  })
}