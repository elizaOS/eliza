import type { ElizaOS, UUID } from '@elizaos/core';
import express from 'express';
import { validateUuid, logger } from '@elizaos/core';
import { sendError } from '../api/shared/response-utils';
import { validateChannelId } from '../api/shared/validation';

/**
 * Middleware to validate that an agent exists
 */
export const agentExistsMiddleware = (elizaOS: ElizaOS) => {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const runtime = elizaOS.getAgent(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    // Add runtime to request object for use in route handlers
    // Extend Express Request type to include our custom properties
    (req as express.Request & { runtime: typeof runtime; agentId: UUID }).runtime = runtime;
    (req as express.Request & { runtime: typeof runtime; agentId: UUID }).agentId = agentId;
    next();
  };
};

/**
 * Middleware to validate UUID parameters
 */
export const validateUuidMiddleware = (paramName: string) => {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const paramValue = String(req.params[paramName]);
    let validatedUuid: UUID | null;

    // Use enhanced validation for channel IDs
    if (paramName === 'channelId') {
      const clientIp = req.ip || 'unknown';
      validatedUuid = validateChannelId(paramValue, clientIp);
    } else {
      validatedUuid = validateUuid(paramValue);
    }

    if (!validatedUuid) {
      // Log security event for invalid IDs
      const clientIp = req.ip || 'unknown';
      logger.warn({ src: 'http', ip: clientIp, paramName, paramValue }, 'Invalid parameter');
      return sendError(res, 400, 'INVALID_ID', `Invalid ${paramName} format`);
    }

    // Add validated UUID to request params
    req.params[paramName] = validatedUuid;
    next();
  };
};

/**
 * Enhanced channel ID validation middleware with additional security
 */
export const validateChannelIdMiddleware = () => {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const channelId = req.params.channelId;
    const clientIp = req.ip || 'unknown';

    if (!channelId) {
      return sendError(res, 400, 'MISSING_CHANNEL_ID', 'Channel ID is required');
    }

    const validatedChannelId = validateChannelId(String(channelId), clientIp);

    if (!validatedChannelId) {
      // Rate limit failed attempts to prevent brute force
      logger.warn({ src: 'http', ip: clientIp, channelId }, 'Failed channel ID validation');
      return sendError(res, 400, 'INVALID_CHANNEL_ID', 'Invalid channel ID format');
    }

    // Store validated channel ID
    req.params.channelId = validatedChannelId;
    next();
  };
};

/**
 * Middleware to validate request content type for POST/PUT/PATCH requests
 */
export const validateContentTypeMiddleware = () => {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Only validate Content-Type for methods that typically have request bodies
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const contentType = req.get('Content-Type');
      const contentLength = req.get('Content-Length');

      // Skip validation if request has no body (Content-Length is 0 or undefined)
      if (!contentLength || contentLength === '0') {
        return next();
      }

      // Allow multipart for file uploads, JSON for regular API requests
      const validTypes = [
        'application/json',
        'multipart/form-data',
        'application/x-www-form-urlencoded',
      ];

      if (!contentType || !validTypes.some((type) => contentType.includes(type))) {
        return sendError(
          res,
          400,
          'INVALID_CONTENT_TYPE',
          'Invalid or missing Content-Type header'
        );
      }
    }

    next();
  };
};
