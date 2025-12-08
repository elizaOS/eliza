import { type Request, type Response, type NextFunction } from 'express';
import { logger } from '@elizaos/core';

export interface ApiKeyAuthRequest extends Request {
  isServerAuthenticated?: boolean;
}

/**
 * API Key authentication middleware.
 *
 * Authenticates frontend→server connection (Layer 1).
 * Only active if ELIZA_SERVER_AUTH_TOKEN is configured.
 *
 * Use case: Prevent unauthorized clients from accessing the API.
 */
export function apiKeyAuthMiddleware(
  req: ApiKeyAuthRequest,
  res: Response,
  next: NextFunction
): void | Response {
  const apiKeyConfigured = !!process.env.ELIZA_SERVER_AUTH_TOKEN;

  // Not configured → Skip authentication (dev mode)
  if (!apiKeyConfigured) {
    logger.debug('[API Key] Not configured - skipping check');
    return next();
  }

  // Allow OPTIONS requests for CORS preflight
  if (req.method === 'OPTIONS') {
    return next();
  }

  // Verify API key
  const apiKey = req.headers?.['x-api-key'];
  if (!apiKey || apiKey !== process.env.ELIZA_SERVER_AUTH_TOKEN) {
    logger.warn(`[API Key] Unauthorized access attempt from ${req.ip}`);
    return res.status(401).json({
      error: 'API key required',
      message: 'Missing or invalid X-API-KEY header',
    });
  }

  // Valid API key
  req.isServerAuthenticated = true;
  logger.debug('[API Key] Valid - frontend authenticated');
  next();
}
