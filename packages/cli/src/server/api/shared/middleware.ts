import type { IAgentRuntime, UUID } from '@elizaos/core';
import express from 'express';
import { validateUuid, logger } from '@elizaos/core';
import { sendError } from './response-utils';

/**
 * Middleware to validate that an agent exists
 */
export const agentExistsMiddleware = (agents: Map<UUID, IAgentRuntime>) => {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    // Add runtime to request object for use in route handlers
    (req as any).runtime = runtime;
    (req as any).agentId = agentId;
    next();
  };
};

/**
 * Middleware to validate UUID parameters
 */
export const validateUuidMiddleware = (paramName: string) => {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const paramValue = req.params[paramName];
    const validatedUuid = validateUuid(paramValue);
    
    if (!validatedUuid) {
      return sendError(res, 400, 'INVALID_ID', `Invalid ${paramName} format`);
    }

    // Add validated UUID to request params
    req.params[paramName] = validatedUuid;
    next();
  };
};

/**
 * Security middleware to add additional API protection
 */
export const securityMiddleware = () => {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Add security headers specific to API responses
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'no-referrer');
    
    // Remove potentially sensitive headers
    res.removeHeader('X-Powered-By');
    res.removeHeader('Server');
    
    // Log security-relevant information
    const userAgent = req.get('User-Agent');
    const forwarded = req.get('X-Forwarded-For');
    const realIp = req.get('X-Real-IP');
    const clientIp = forwarded || realIp || req.ip;
    
    // Log suspicious patterns
    if (userAgent && (userAgent.includes('..') || userAgent.includes('<script'))) {
      logger.warn(`[SECURITY] Suspicious User-Agent from ${clientIp}: ${userAgent}`);
    }
    
    // Check for suspicious request patterns
    const suspiciousPatterns = [
      /\.\./,        // Path traversal
      /<script/i,    // XSS attempts
      /union.*select/i, // SQL injection
      /javascript:/i,   // JavaScript injection
    ];
    
    const url = req.originalUrl || req.url;
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(url) || pattern.test(JSON.stringify(req.query))) {
        logger.warn(`[SECURITY] Suspicious request pattern from ${clientIp}: ${url}`);
        break;
      }
    }
    
    next();
  };
};

/**
 * Middleware to validate request content type for POST/PUT/PATCH requests
 */
export const validateContentTypeMiddleware = () => {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const contentType = req.get('Content-Type');
      
      // Allow multipart for file uploads, JSON for regular API requests
      const validTypes = [
        'application/json',
        'multipart/form-data',
        'application/x-www-form-urlencoded'
      ];
      
      if (!contentType || !validTypes.some(type => contentType.includes(type))) {
        return sendError(res, 400, 'INVALID_CONTENT_TYPE', 'Invalid or missing Content-Type header');
      }
    }
    
    next();
  };
};