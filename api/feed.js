const { handleFeed } = require('../website/scripts/feed-core.cjs');

module.exports = async function handler(req, res) {
  const result = await handleFeed({
    method: req.method,
    headers: req.headers || {},
    url: req.url || ''
  }, process.env, fetch);
  res.statusCode = result.status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(result.body));
};
