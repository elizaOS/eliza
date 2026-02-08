import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { logger, validateUuid, type UUID } from '@elizaos/core';
import { jwtVerifier } from '../services/jwt-verifier.js';

/**
 * Extended Request with entity identification.
 * The entityId is set by the middleware regardless of method (header or JWT).
 */
export interface AuthenticatedRequest extends Request {
  entityId?: UUID;
  jwtSub?: string;
  jwtPayload?: any;
}

/**
 * Public routes that skip authentication.
 */
const PUBLIC_AUTH_ROUTES = [
  '/auth/register',
  '/auth/login',
  '/auth/refresh',
  '/system/version',
  '/system/config',
];

/**
 * Middleware for legacy mode (without data isolation).
 * Extracts entityId from X-Entity-Id header.
 */
function entityIdHeaderMiddleware(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void {
  const headerEntityId = req.headers['x-entity-id'] as string;
  if (headerEntityId) {
    const validatedId = validateUuid(headerEntityId);
    if (validatedId) {
      req.entityId = validatedId;
    }
  }
  next();
}

/**
 * Internal service secret - generated at startup for service-to-service auth.
 * This ensures only internal services (same process) can bypass JWT.
 */
const INTERNAL_SERVICE_SECRET = randomUUID();

/**
 * Get the internal service secret for use by other services in same process.
 */
export function getInternalServiceSecret(): string {
  return INTERNAL_SERVICE_SECRET;
}

/**
 * Check if request is an internal service-to-service call.
 * Internal calls must: come from localhost AND have valid internal secret.
 */
function isInternalServiceCall(req: Request): boolean {
  const ip = req.ip || req.socket?.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const internalSecret = req.headers?.['x-internal-service-secret'] as string;
  return isLocalhost && internalSecret === INTERNAL_SERVICE_SECRET;
}

/**
 * Middleware for secure mode (with data isolation).
 * Verifies JWT and extracts entityId from token payload.
 * Skips JWT for internal service calls (localhost + X-Internal-Service header).
 */
export function jwtAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void | Response {
  const currentPath = req.path || req.url;

  // Skip public auth endpoints
  if (PUBLIC_AUTH_ROUTES.some((route) => currentPath.endsWith(route))) {
    return next();
  }

  // Skip JWT for internal service-to-service calls (localhost + API key)
  if (isInternalServiceCall(req)) {
    return next();
  }

  // Check if JWT verifier is configured
  if (!jwtVerifier.isEnabled()) {
    logger.warn({ src: 'http', path: currentPath }, 'Data isolation enabled but JWT verifier not configured');
    return next();
  }

  const authHeader = req.headers?.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn({ src: 'http', ip: req.ip, path: currentPath }, 'Missing JWT token');
    return res.status(401).json({
      error: 'JWT token required for data isolation',
    });
  }

  const token = authHeader.replace('Bearer ', '');

  jwtVerifier
    .verify(token)
    .then(({ entityId, sub, payload }) => {
      req.entityId = entityId;
      req.jwtSub = sub;
      req.jwtPayload = payload;
      next();
    })
    .catch((error) => {
      logger.warn({ src: 'http', ip: req.ip, path: currentPath, error: error.message }, 'JWT authentication failed');
      return res.status(401).json({
        error: 'Invalid JWT token',
        details: error.message,
      });
    });
}

/**
 * Factory that creates the appropriate auth middleware based on configuration.
 *
 * - Without ENABLE_DATA_ISOLATION: uses X-Entity-Id header (legacy mode)
 * - With ENABLE_DATA_ISOLATION: uses JWT authentication (secure mode)
 *
 * The mode is determined once at startup for optimal performance.
 */
export function createEntityAuthMiddleware(): RequestHandler {
  const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === 'true';

  if (dataIsolationEnabled) {
    logger.info({ src: 'auth' }, 'Using JWT authentication (data isolation enabled)');
    return jwtAuthMiddleware;
  }

  logger.info({ src: 'auth' }, 'Using X-Entity-Id header (legacy mode)');
  return entityIdHeaderMiddleware;
}

/**
 * Require JWT middleware - fails if no valid JWT.
 */
export function requireJWT(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void | Response {
  if (!req.entityId) {
    return res.status(401).json({
      error: 'Authentication required',
    });
  }
  next();
}
