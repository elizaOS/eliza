export default function handler(req, res) {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'xmrt-eliza',
    ecosystem: 'XMRT-DAO',
    version: process.env.npm_package_version || '1.0.0'
  })
}