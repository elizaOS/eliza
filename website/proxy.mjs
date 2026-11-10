import { next, rewrite } from '@vercel/functions';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { routeForHost } = require('./host-route.cjs');

export default function proxy(request) {
  const current = new URL(request.url);
  const destination = routeForHost(request.headers.get('host'), current.pathname);
  if (!destination) return next();
  current.pathname = destination;
  current.search = '';
  return rewrite(current);
}
