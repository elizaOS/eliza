export default function handler(req, res) {
  const agents = [
    { 
      id: 'eliza', 
      name: 'Eliza (Coordinator)', 
      status: 'active', 
      role: 'coordinator',
      capabilities: ['decision-making', 'coordination', 'governance']
    },
    { 
      id: 'security', 
      name: 'Security Guardian', 
      status: 'active', 
      role: 'security',
      capabilities: ['threat-detection', 'audit', 'compliance']
    },
    { 
      id: 'defi', 
      name: 'DeFi Specialist', 
      status: 'active', 
      role: 'defi',
      capabilities: ['liquidity-management', 'yield-optimization']
    },
    { 
      id: 'community', 
      name: 'Community Manager', 
      status: 'active', 
      role: 'community',
      capabilities: ['engagement', 'communication']
    }
  ]
  
  res.status(200).json({ 
    agents, 
    ecosystem: 'XMRT-DAO',
    total: agents.length
  })
}