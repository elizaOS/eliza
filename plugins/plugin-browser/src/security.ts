/**
 * Security configuration and utilities for the browser plugin
 */

import { BrowserSecurityError } from './errors';

/**
 * Security configuration
 */
export interface SecurityConfig {
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxUrlLength?: number;
  allowLocalhost?: boolean;
  allowFileProtocol?: boolean;
  sanitizeInputs?: boolean;
}

/**
 * Default security configuration
 */
const defaultSecurityConfig: SecurityConfig = {
  allowedDomains: undefined, // If undefined, allow all domains except blocked
  blockedDomains: [
    // Common malicious domains
    'malware.com',
    'phishing.com',
    // Add more as needed
  ],
  maxUrlLength: 2048,
  allowLocalhost: true,
  allowFileProtocol: false,
  sanitizeInputs: true,
};

/**
 * URL validation and sanitization
 */
export class UrlValidator {
  private config: SecurityConfig;

  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = { ...defaultSecurityConfig, ...config };
  }

  /**
   * Validate if a URL is allowed
   */
  validateUrl(url: string): { valid: boolean; sanitized?: string; error?: string } {
    try {
      // Check URL length
      if (url.length > (this.config.maxUrlLength || 2048)) {
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
      if (this.config.blockedDomains) {
        for (const blocked of this.config.blockedDomains) {
          if (parsedUrl.hostname.includes(blocked)) {
            return { valid: false, error: `Domain ${blocked} is blocked` };
          }
        }
      }

      // Check against allowed domains (if specified)
      if (this.config.allowedDomains && this.config.allowedDomains.length > 0) {
        const isAllowed = this.config.allowedDomains.some(
          (allowed) => parsedUrl.hostname === allowed || parsedUrl.hostname.endsWith(`.${allowed}`)
        );
        if (!isAllowed) {
          return { valid: false, error: 'Domain is not in the allowed list' };
        }
      }

      return { valid: true, sanitized: parsedUrl.href };
    } catch (error) {
      return { valid: false, error: 'Error validating URL' };
    }
  }

  /**
   * Update security configuration
   */
  updateConfig(config: Partial<SecurityConfig>) {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Input sanitization utilities
 */
export class InputSanitizer {
  /**
   * Sanitize text input to prevent XSS and injection attacks
   */
  static sanitizeText(input: string): string {
    return input
      .replace(/[<>]/g, '') // Remove HTML tags
      .replace(/javascript:/gi, '') // Remove javascript: protocol
      .replace(/on\w+\s*=/gi, '') // Remove event handlers
      .trim();
  }

  /**
   * Sanitize selector strings for browser actions
   */
  static sanitizeSelector(selector: string): string {
    // Remove potentially dangerous characters in selectors
    return selector
      .replace(/['"]/g, '') // Remove quotes that could break selectors
      .replace(/[<>]/g, '') // Remove HTML tags
      .trim();
  }

  /**
   * Sanitize file paths
   */
  static sanitizeFilePath(path: string): string {
    // Remove path traversal attempts
    return path
      .replace(/\.\./g, '')
      .replace(/[<>:"|?*]/g, '') // Remove invalid filename characters
      .trim();
  }
}

/**
 * Security middleware for actions
 */
export function validateSecureAction(url: string | null, validator: UrlValidator): void {
  if (!url) {
    return;
  }

  const validation = validator.validateUrl(url);
  if (!validation.valid) {
    throw new BrowserSecurityError(`URL validation failed: ${validation.error}`, {
      url,
      error: validation.error,
    });
  }
}

/**
 * Create a default URL validator instance
 */
export const defaultUrlValidator = new UrlValidator();

/**
 * Rate limiting configuration
 */
export interface RateLimitConfig {
  maxActionsPerMinute: number;
  maxSessionsPerHour: number;
}

/**
 * Simple rate limiter
 */
export class RateLimiter {
  private actionCounts: Map<string, { count: number; resetTime: number }> = new Map();
  private sessionCounts: Map<string, { count: number; resetTime: number }> = new Map();

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
        resetTime: now + 60000, // 1 minute
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
        resetTime: now + 3600000, // 1 hour
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
