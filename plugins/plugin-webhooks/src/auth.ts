/**
 * @module auth
 * @description Token-based authentication for webhook endpoints.
 *
 * Supports three methods (in priority order):
 *   1. Authorization: Bearer <token>
 *   2. x-otto-token: <token>
 *   3. ?token=<token> (deprecated, logs a warning)
 */

import { logger } from '@elizaos/core';
import { timingSafeEqual } from 'node:crypto';

export function extractToken(req: {
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[]>;
  url?: string;
}): string | undefined {
  const headers = req.headers ?? {};

  // 1. Authorization: Bearer <token>
  const authHeader = headers.authorization ?? headers.Authorization;
  const authStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (typeof authStr === 'string' && authStr.startsWith('Bearer ')) {
    return authStr.slice(7).trim();
  }

  // 2. x-otto-token header
  const ottoHeader = headers['x-otto-token'] ?? headers['X-Otto-Token'];
  const ottoStr = Array.isArray(ottoHeader) ? ottoHeader[0] : ottoHeader;
  if (typeof ottoStr === 'string' && ottoStr.trim()) {
    return ottoStr.trim();
  }

  // 3. Query parameter (deprecated)
  let queryToken: string | undefined;
  if (req.query && typeof req.query.token === 'string') {
    queryToken = req.query.token;
  } else if (typeof req.url === 'string') {
    const url = new URL(req.url, 'http://localhost');
    queryToken = url.searchParams.get('token') ?? undefined;
  }

  if (queryToken) {
    logger.warn('[Webhooks] Query-param token auth is deprecated; use Authorization header instead');
    return queryToken.trim();
  }

  return undefined;
}

export function validateToken(
  req: { headers?: Record<string, string | string[] | undefined>; query?: Record<string, string | string[]>; url?: string },
  expectedToken: string,
): boolean {
  const provided = extractToken(req);
  if (!provided) {
    return false;
  }

  // Use Node's crypto.timingSafeEqual for constant-time comparison
  const providedBuf = Buffer.from(provided, 'utf-8');
  const expectedBuf = Buffer.from(expectedToken, 'utf-8');

  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(providedBuf, expectedBuf);
}
