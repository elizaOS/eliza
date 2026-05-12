/**
 * Simple API key authentication middleware
 * Currently disabled - for future use
 */
const logger = require('../utils/logger');

const API_KEYS = new Set([
  'tk_live_a8f3b2c1d4e5f6789012345678901234',
  'tk_test_b9c4d3e2f5a6b7890123456789012345'
]);

function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    logger.warn('Request missing API key', { ip: req.ip, path: req.path });
    return res.status(401).json({ error: 'API key required' });
  }

  if (!API_KEYS.has(apiKey)) {
    logger.warn('Invalid API key attempt', { ip: req.ip, path: req.path });
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
}

module.exports = { authenticate };
