import type { IAgentRuntime, UUID } from '@elizaos/core';
import express from 'express';
import { validateUuid, logger } from '@elizaos/core';
import { sendError } from './response-utils';
import rateLimit from 'express-rate-limit';

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

    // Check for suspicious request patterns with safe, non-backtracking regexes
    const url = req.originalUrl || req.url;
    const queryString = JSON.stringify(req.query);

    // Use safer string matching instead of potentially dangerous regexes
    const suspiciousIndicators = [
      { pattern: '..', name: 'Path traversal' },
      { pattern: '<script', name: 'XSS attempt' },
      { pattern: 'javascript:', name: 'JavaScript injection' },
    ];

    // Safe SQL injection detection without backtracking regex
    const sqlKeywords = ['union', 'select', 'drop', 'delete', 'insert', 'update'];
    let hasSqlPattern = false;
    const lowerUrl = url.toLowerCase();
    const lowerQuery = queryString.toLowerCase();

    // Check for SQL injection patterns more safely
    for (let i = 0; i < sqlKeywords.length - 1; i++) {
      const keyword1 = sqlKeywords[i];
      for (let j = i + 1; j < sqlKeywords.length; j++) {
        const keyword2 = sqlKeywords[j];
        if (
          (lowerUrl.includes(keyword1) && lowerUrl.includes(keyword2)) ||
          (lowerQuery.includes(keyword1) && lowerQuery.includes(keyword2))
        ) {
          hasSqlPattern = true;
          break;
        }
      }
      if (hasSqlPattern) break;
    }

    // Check for other suspicious patterns
    for (const indicator of suspiciousIndicators) {
      if (url.includes(indicator.pattern) || queryString.includes(indicator.pattern)) {
        logger.warn(`[SECURITY] ${indicator.name} detected from ${clientIp}: ${url}`);
        break;
      }
    }

    if (hasSqlPattern) {
      logger.warn(`[SECURITY] SQL injection pattern detected from ${clientIp}: ${url}`);
    }

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

/**
 * General API rate limiting middleware
 */
export const createApiRateLimit = () => {
  return rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // Limit each IP to 1000 requests per windowMs
    message: {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please try again later.',
      },
    },
    standardHeaders: true, // Return rate limit info in the `RateLimitInfo` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    handler: (req, res) => {
      const clientIp = req.ip || 'unknown';
      logger.warn(`[SECURITY] Rate limit exceeded for IP: ${clientIp}`);
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please try again later.',
        },
      });
    },
  });
};

/**
 * Strict rate limiting for file system operations
 */
export const createFileSystemRateLimit = () => {
  return rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 100, // Limit each IP to 100 file operations per 5 minutes
    message: {
      success: false,
      error: {
        code: 'FILE_RATE_LIMIT_EXCEEDED',
        message: 'Too many file operations. Please try again later.',
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const clientIp = req.ip || 'unknown';
      logger.warn(
        `[SECURITY] File system rate limit exceeded for IP: ${clientIp}, endpoint: ${req.path}`
      );
      res.status(429).json({
        success: false,
        error: {
          code: 'FILE_RATE_LIMIT_EXCEEDED',
          message: 'Too many file operations. Please try again later.',
        },
      });
    },
  });
};

/**
 * Very strict rate limiting for upload operations
 */
export const createUploadRateLimit = () => {
  return rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // Limit each IP to 50 uploads per 15 minutes
    message: {
      success: false,
      error: {
        code: 'UPLOAD_RATE_LIMIT_EXCEEDED',
        message: 'Too many upload attempts. Please try again later.',
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const clientIp = req.ip || 'unknown';
      logger.warn(
        `[SECURITY] Upload rate limit exceeded for IP: ${clientIp}, endpoint: ${req.path}`
      );
      res.status(429).json({
        success: false,
        error: {
          code: 'UPLOAD_RATE_LIMIT_EXCEEDED',
          message: 'Too many upload attempts. Please try again later.',
        },
      });
    },
  });
};
