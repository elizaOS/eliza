import Head from 'next/head'

export default function Home() {
  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <Head>
        <title>XMRT-Eliza | XMRT-DAO Ecosystem</title>
      </Head>

      <h1 style={{ color: '#667eea' }}>🤖 XMRT-Eliza Server</h1>
      <p>XMRT-DAO AI Agent System - Successfully deployed on Vercel!</p>
      
      <div style={{ marginTop: '2rem' }}>
        <h2>🌐 XMRT Ecosystem</h2>
        <ul>
          <li><a href="https://suite.lovable.app/">Suite AI Platform</a></li>
          <li><a href="https://xmrt-ecosystem.vercel.app/">XMRT Ecosystem</a></li>
          <li><a href="/api/health">Health Check</a></li>
          <li><a href="/api/agents">Agents List</a></li>
          <li><a href="/api/status">System Status</a></li>
        </ul>
      </div>
      
      <div style={{ marginTop: '2rem', padding: '1rem', background: '#f0f9ff', borderRadius: '8px' }}>
        <h3>✅ Deployment Successful!</h3>
        <p>Your XMRT-Eliza system is now running on Vercel with Next.js framework.</p>
      </div>
    </div>
  )
}