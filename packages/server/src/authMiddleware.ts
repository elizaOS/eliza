import { type Request, type Response, type NextFunction } from 'express';
import { logger } from '@elizaos/core';

/**
 * Express middleware for validating API Key authentication based on an environment variable.
 *
 * If the ELIZA_SERVER_AUTH_TOKEN environment variable is set, this middleware
 * checks for a matching 'X-API-KEY' header in incoming requests.
 *
 * If the environment variable is *not* set, the middleware allows all requests
 * to pass through without authentication checks.
 *
 * @param req - Express request object.
 * @param res - Express response object.
 * @param next - Express next function.
 */
export function apiKeyAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const serverAuthToken = process.env.ELIZA_SERVER_AUTH_TOKEN;

  // If no token is configured in ENV, skip auth check
  if (!serverAuthToken) {
    return next();
  }

  // Allow OPTIONS requests for CORS preflight
  if (req.method === 'OPTIONS') {
    return next();
  }

  const apiKey = req.headers?.['x-api-key'];

  if (!apiKey || apiKey !== serverAuthToken) {
    logger.warn(`Unauthorized access attempt: Missing or invalid X-API-KEY from ${req.ip}`);
    return res.status(401).send('Unauthorized: Invalid or missing X-API-KEY');
  }

  // If key is valid, proceed
  next();
}
