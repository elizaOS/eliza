const { handleAi, readRawBody } = require('../website/scripts/ai-core.cjs');

module.exports = async function handler(req, res) {
  const raw = await readRawBody(req);
  const result = await handleAi({
    method: req.method,
    headers: req.headers || {},
    body: raw
  }, process.env, fetch);
  res.statusCode = result.status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(result.body));
};
