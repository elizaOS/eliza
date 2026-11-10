const { next, rewrite } = require('@vercel/functions');
const { routeForHost } = require('./host-route.cjs');

function proxy(request) {
  const current = new URL(request.url);
  const destination = routeForHost(request.headers.get('host'), current.pathname);
  if (!destination) return next();
  current.pathname = destination;
  current.search = '';
  return rewrite(current);
}

module.exports = proxy;
