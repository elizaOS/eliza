'use strict';

const VOLOS_HOSTS = new Set(['valos.live', 'www.valos.live']);

function normalizeHost(host) {
  return String(host || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

function routeForHost(host, pathname) {
  if (!VOLOS_HOSTS.has(normalizeHost(host))) return null;
  if (pathname === '/' || pathname === '/index.html') return '/volos/index.html';
  return null;
}

module.exports = { VOLOS_HOSTS, normalizeHost, routeForHost };
