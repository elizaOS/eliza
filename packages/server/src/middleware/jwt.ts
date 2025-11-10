import type { Request, Response, NextFunction } from 'express';
import { logger, type UUID } from '@elizaos/core';
import { jwtVerifier } from './jwt-verifier';

/**
 * Extended Request with JWT authentication data.
 */
export interface JWTAuthRequest extends Request {
  userId?: UUID;      // entityId extracted from JWT
  jwtSub?: string;    // JWT sub claim
  jwtPayload?: any;   // Full JWT payload
}

/**
 * JWT Authentication Middleware.
 *
 * Extracts JWT from Authorization header, verifies it, and sets req.userId.
 * Works with any JWT provider (Privy, CDP, Auth0, custom).
 *
 * @param req - Express request
 * @param res - Express response
 * @param next - Express next function
 */
export function jwtAuthMiddleware(
  req: JWTAuthRequest,
  res: Response,
  next: NextFunction
): void | Response {
  // Skip if JWT not configured
  if (!jwtVerifier.isEnabled()) {
    return next();
  }

  // Extract Bearer token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // No JWT provided - check if required
    const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === 'true';
    if (dataIsolationEnabled) {
      logger.warn('[JWT Auth] Missing JWT token (ENABLE_DATA_ISOLATION=true)');
      return res.status(401).json({
        error: 'JWT token required for data isolation',
      });
    }
    // JWT optional - continue without authentication
    return next();
  }

  const token = authHeader.replace('Bearer ', '');

  jwtVerifier
    .verify(token)
    .then(({ entityId, sub, payload }) => {
      // JWT valid - set user context
      req.userId = entityId;
      req.jwtSub = sub;
      req.jwtPayload = payload;

      logger.debug(
        `[JWT Auth] Authenticated: ${sub} → entityId: ${entityId.substring(0, 8)}... (issuer: ${payload.iss || 'unknown'})`
      );

      next();
    })
    .catch((error) => {
      logger.error('[JWT Auth] Authentication failed:', error.message);
      return res.status(401).json({
        error: 'Invalid JWT token',
        details: error.message,
      });
    });
}

/**
 * Require JWT middleware - fails if no valid JWT.
 *
 * Use this for endpoints that MUST have JWT authentication.
 */
export function requireJWT(
  req: JWTAuthRequest,
  res: Response,
  next: NextFunction
): void | Response {
  if (!req.userId) {
    return res.status(401).json({
      error: 'JWT authentication required',
    });
  }
  next();
}