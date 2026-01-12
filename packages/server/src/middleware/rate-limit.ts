import rateLimit from 'express-rate-limit';
import { logger } from '@elizaos/core';
import { validateChannelId } from '../api/shared/validation';

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
      logger.warn({ src: 'http', ip: clientIp }, 'Rate limit exceeded');
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
      logger.warn({ src: 'http', ip: clientIp, path: req.path }, 'File system rate limit exceeded');
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
      logger.warn({ src: 'http', ip: clientIp, path: req.path }, 'Upload rate limit exceeded');
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

/**
 * Rate limiting specifically for channel validation attempts
 * Prevents brute force attacks on channel IDs
 */
export const createChannelValidationRateLimit = () => {
  return rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 200, // Limit each IP to 200 channel validation attempts per 10 minutes
    message: {
      success: false,
      error: {
        code: 'CHANNEL_VALIDATION_RATE_LIMIT_EXCEEDED',
        message: 'Too many channel validation attempts. Please try again later.',
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      // Skip rate limiting if channel ID is valid (successful validations)
      const channelId = req.params.channelId;
      if (channelId) {
        const clientIp = req.ip || 'unknown';
        const validatedChannelId = validateChannelId(String(channelId), clientIp);
        return !!validatedChannelId; // Skip if valid
      }
      return false; // Apply rate limiting for invalid attempts
    },
    handler: (req, res) => {
      const clientIp = req.ip || 'unknown';
      const channelId = req.params.channelId || 'unknown';
      logger.warn(
        { src: 'http', ip: clientIp, channelId },
        'Channel validation rate limit exceeded'
      );
      res.status(429).json({
        success: false,
        error: {
          code: 'CHANNEL_VALIDATION_RATE_LIMIT_EXCEEDED',
          message: 'Too many channel validation attempts. Please try again later.',
        },
      });
    },
  });
};
