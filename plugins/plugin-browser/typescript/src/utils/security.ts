/**
 * Security utilities for the browser plugin
 * Provides URL validation, input sanitization, and rate limiting
 */

import { SecurityError } from './errors.js';
import type { SecurityConfig, RateLimitConfig, RateLimitEntry } from '../types.js';

const DEFAULT_SECURITY_CONFIG: Required<SecurityConfig> = {
  allowedDomains: [],
  blockedDomains: ['malware.com', 'phishing.com'],
  maxUrlLength: 2048,
  allowLocalhost: true,
  allowFileProtocol: false,
};

/**
 * URL Validator class for secure URL handling
 */
export class UrlValidator {
  private config: Required<SecurityConfig>;

  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = { ...DEFAULT_SECURITY_CONFIG, ...config };
  }

  /**
   * Validate if a URL is allowed
   */
  validate(url: string): { valid: boolean; sanitized?: string; error?: string } {
    try {
      // Check URL length
      if (url.length > this.config.maxUrlLength) {
        return { valid: false, error: 'URL is too long' };
      }

      // Parse URL
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        // Try adding https:// if no protocol
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          try {
            parsedUrl = new URL(`https://${url}`);
          } catch {
            return { valid: false, error: 'Invalid URL format' };
          }
        } else {
          return { valid: false, error: 'Invalid URL format' };
        }
      }

      // Check protocol
      if (parsedUrl.protocol === 'file:' && !this.config.allowFileProtocol) {
        return { valid: false, error: 'File protocol is not allowed' };
      }

      if (!['http:', 'https:', 'file:'].includes(parsedUrl.protocol)) {
        return { valid: false, error: 'Only HTTP(S) protocols are allowed' };
      }

      // Check localhost
      const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname);
      if (isLocalhost && !this.config.allowLocalhost) {
        return { valid: false, error: 'Localhost URLs are not allowed' };
      }

      // Check against blocked domains
      for (const blocked of this.config.blockedDomains) {
        if (parsedUrl.hostname.includes(blocked)) {
          return { valid: false, error: `Domain ${blocked} is blocked` };
        }
      }

      // Check against allowed domains (if specified)
      if (this.config.allowedDomains.length > 0) {
        const isAllowed = this.config.allowedDomains.some(
          (allowed) => parsedUrl.hostname === allowed || parsedUrl.hostname.endsWith(`.${allowed}`)
        );
        if (!isAllowed) {
          return { valid: false, error: 'Domain is not in the allowed list' };
        }
      }

      return { valid: true, sanitized: parsedUrl.href };
    } catch {
      return { valid: false, error: 'Error validating URL' };
    }
  }

  /**
   * Update security configuration
   */
  updateConfig(config: Partial<SecurityConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Input sanitization utilities
 */
export const InputSanitizer = {
  /**
   * Sanitize text input to prevent XSS and injection attacks
   */
  sanitizeText(input: string): string {
    return input
      .replace(/[<>]/g, '')
      .replace(/javascript:/gi, '')
      .replace(/on\w+\s*=/gi, '')
      .trim();
  },

  /**
   * Sanitize selector strings for browser actions
   */
  sanitizeSelector(selector: string): string {
    return selector
      .replace(/['"]/g, '')
      .replace(/[<>]/g, '')
      .trim();
  },

  /**
   * Sanitize file paths
   */
  sanitizeFilePath(path: string): string {
    return path
      .replace(/\.\./g, '')
      .replace(/[<>:"|?*]/g, '')
      .trim();
  },
};

/**
 * Validate URL security for actions
 */
export function validateSecureAction(url: string | null, validator: UrlValidator): void {
  if (!url) {
    return;
  }

  const validation = validator.validate(url);
  if (!validation.valid) {
    throw new SecurityError(`URL validation failed: ${validation.error}`, {
      url,
      error: validation.error,
    });
  }
}

/**
 * Default URL validator instance
 */
export const defaultUrlValidator = new UrlValidator();

/**
 * Rate limiter for preventing abuse
 */
export class RateLimiter {
  private actionCounts = new Map<string, RateLimitEntry>();
  private sessionCounts = new Map<string, RateLimitEntry>();

  constructor(private config: RateLimitConfig) {}

  /**
   * Check if an action is allowed
   */
  checkActionLimit(userId: string): boolean {
    const now = Date.now();
    const userLimit = this.actionCounts.get(userId);

    if (!userLimit || now > userLimit.resetTime) {
      this.actionCounts.set(userId, {
        count: 1,
        resetTime: now + 60000,
      });
      return true;
    }

    if (userLimit.count >= this.config.maxActionsPerMinute) {
      return false;
    }

    userLimit.count++;
    return true;
  }

  /**
   * Check if a new session is allowed
   */
  checkSessionLimit(userId: string): boolean {
    const now = Date.now();
    const userLimit = this.sessionCounts.get(userId);

    if (!userLimit || now > userLimit.resetTime) {
      this.sessionCounts.set(userId, {
        count: 1,
        resetTime: now + 3600000,
      });
      return true;
    }

    if (userLimit.count >= this.config.maxSessionsPerHour) {
      return false;
    }

    userLimit.count++;
    return true;
  }
}


