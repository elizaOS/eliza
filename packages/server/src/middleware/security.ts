import express from 'express';
import { logger } from '@elizaos/core';

/**
 * Security middleware to add additional API protection
 * - Adds security headers
 * - Removes potentially sensitive headers
 * - Logs suspicious request patterns
 */
export const securityMiddleware = () => {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Add security headers specific to API responses
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // Changed from DENY to allow same-origin iframes, otherwise we can load panels from plugins
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
