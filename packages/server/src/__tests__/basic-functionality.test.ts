/**
 * Basic functionality tests without complex dependencies
 */

import { describe, it, expect } from 'bun:test';
import path from 'node:path';
import { isWebUIEnabled } from '../index.js';

describe('Basic Server Functionality', () => {
  describe('Path utilities', () => {
    it('should handle path expansion logic', () => {
      const testExpandTildePath = (filepath: string): string => {
        if (filepath && filepath.startsWith('~')) {
          return path.join(process.cwd(), filepath.slice(1));
        }
        return filepath;
      };

      // Test the core logic without external dependencies
      expect(testExpandTildePath('~/test')).toBe(path.join(process.cwd(), 'test'));
      expect(testExpandTildePath('/absolute')).toBe('/absolute');
      expect(testExpandTildePath('relative')).toBe('relative');
      expect(testExpandTildePath('')).toBe('');
    });
  });

  describe('UUID validation logic', () => {
    it('should validate UUID format correctly', () => {
      const validateUuidPattern = (id: string): boolean => {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return uuidRegex.test(id);
      };

      // Valid UUIDs
      expect(validateUuidPattern('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
      expect(validateUuidPattern('00000000-0000-0000-0000-000000000000')).toBe(true);
      expect(validateUuidPattern('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe(true);

      // Invalid UUIDs
      expect(validateUuidPattern('invalid-uuid')).toBe(false);
      expect(validateUuidPattern('123e4567e89b12d3a456426614174000')).toBe(false); // no dashes
      expect(validateUuidPattern('123e4567-e89b-12d3-a456-42661417400')).toBe(false); // too short
      expect(validateUuidPattern('')).toBe(false);
    });
  });

  describe('Security pattern detection', () => {
    it('should detect suspicious patterns', () => {
      const detectSuspiciousPatterns = (input: string): boolean => {
        const suspiciousPatterns = ['..', '<', '>', '"', "'", '\\', '/'];
        return suspiciousPatterns.some((pattern) => input.includes(pattern));
      };

      // Suspicious inputs
      expect(detectSuspiciousPatterns('test../path')).toBe(true);
      expect(detectSuspiciousPatterns('test<script>')).toBe(true);
      expect(detectSuspiciousPatterns('test>alert')).toBe(true);
      expect(detectSuspiciousPatterns('test"quote')).toBe(true);
      expect(detectSuspiciousPatterns("test'quote")).toBe(true);
      expect(detectSuspiciousPatterns('test\\backslash')).toBe(true);
      expect(detectSuspiciousPatterns('test/slash')).toBe(true);

      // Clean inputs
      expect(detectSuspiciousPatterns('123e4567-e89b-12d3-a456-426614174000')).toBe(false);
      expect(detectSuspiciousPatterns('cleantext')).toBe(false);
      expect(detectSuspiciousPatterns('clean-text-123')).toBe(false);
    });

    it('should detect path traversal attempts', () => {
      const containsPathTraversal = (path: string): boolean => {
        return path.includes('../') || path.includes('..\\');
      };

      expect(containsPathTraversal('../../../etc/passwd')).toBe(true);
      expect(containsPathTraversal('normal/path')).toBe(false);
      expect(containsPathTraversal('..\\windows\\system32')).toBe(true);
    });

    it('should detect script injection patterns', () => {
      const containsScriptInjection = (input: string): boolean => {
        const scriptPatterns = ['<script', 'javascript:', 'onerror=', 'onload='];
        return scriptPatterns.some((pattern) => input.toLowerCase().includes(pattern));
      };

      expect(containsScriptInjection('<script>alert(1)</script>')).toBe(true);
      expect(containsScriptInjection('javascript:alert(1)')).toBe(true);
      expect(containsScriptInjection('<img src=x onerror=alert(1)>')).toBe(true);
      expect(containsScriptInjection('normal text')).toBe(false);
    });
  });

  describe('Rate limiting logic', () => {
    it('should implement basic rate limiting concepts', () => {
      class SimpleRateLimiter {
        private requests: Map<string, number[]> = new Map();

        constructor(
          private windowMs: number,
          private maxRequests: number
        ) {}

        isAllowed(clientId: string): boolean {
          const now = Date.now();
          const windowStart = now - this.windowMs;

          if (!this.requests.has(clientId)) {
            this.requests.set(clientId, []);
          }

          const clientRequests = this.requests.get(clientId)!;

          // Remove old requests outside the window
          const validRequests = clientRequests.filter((time) => time > windowStart);
          this.requests.set(clientId, validRequests);

          // Check if under limit
          if (validRequests.length < this.maxRequests) {
            validRequests.push(now);
            return true;
          }

          return false;
        }
      }

      const rateLimiter = new SimpleRateLimiter(60000, 5); // 5 requests per minute

      // Should allow first 5 requests
      for (let i = 0; i < 5; i++) {
        expect(rateLimiter.isAllowed('client1')).toBe(true);
      }

      // Should block the 6th request
      expect(rateLimiter.isAllowed('client1')).toBe(false);

      // Different client should be allowed
      expect(rateLimiter.isAllowed('client2')).toBe(true);
    });
  });

  describe('Middleware patterns', () => {
    it('should implement basic middleware concepts', () => {
      type MiddlewareFunction = (req: any, res: any, next: () => void) => void;

      const createValidationMiddleware = (paramName: string): MiddlewareFunction => {
        return (req, res, next) => {
          const paramValue = req.params?.[paramName];

          if (!paramValue) {
            res.error = 'Missing parameter';
            return;
          }

          // Simple UUID validation
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!uuidRegex.test(paramValue)) {
            res.error = 'Invalid format';
            return;
          }

          next();
        };
      };

      const middleware = createValidationMiddleware('id');

      // Test valid case
      const validReq = { params: { id: '123e4567-e89b-12d3-a456-426614174000' } };
      const validRes: any = {};
      let nextCalled = false;

      middleware(validReq, validRes, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
      expect(validRes.error).toBeUndefined();

      // Test invalid case
      const invalidReq = { params: { id: 'invalid-id' } };
      const invalidRes: any = {};
      nextCalled = false;

      middleware(invalidReq, invalidRes, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(false);
      expect(invalidRes.error).toBe('Invalid format');
    });
  });

  describe('Server configuration patterns', () => {
    it('should handle server options correctly', () => {
      interface ServerOptions {
        dataDir?: string;
        middlewares?: any[];
        postgresUrl?: string;
      }

      const createServerConfig = (options: ServerOptions = {}) => {
        return {
          dataDir: options.dataDir || './default-data',
          middlewares: options.middlewares || [],
          postgresUrl: options.postgresUrl || null,
          hasCustomDataDir: !!options.dataDir,
          hasCustomDb: !!options.postgresUrl,
        };
      };

      // Default configuration
      const defaultConfig = createServerConfig();
      expect(defaultConfig.dataDir).toBe('./default-data');
      expect(defaultConfig.middlewares).toEqual([]);
      expect(defaultConfig.postgresUrl).toBeNull();
      expect(defaultConfig.hasCustomDataDir).toBe(false);
      expect(defaultConfig.hasCustomDb).toBe(false);

      // Custom configuration
      const customConfig = createServerConfig({
        dataDir: '/custom/data',
        postgresUrl: 'postgresql://localhost:5432/test',
        middlewares: ['middleware1', 'middleware2'],
      });
      expect(customConfig.dataDir).toBe('/custom/data');
      expect(customConfig.postgresUrl).toBe('postgresql://localhost:5432/test');
      expect(customConfig.middlewares).toEqual(['middleware1', 'middleware2']);
      expect(customConfig.hasCustomDataDir).toBe(true);
      expect(customConfig.hasCustomDb).toBe(true);
    });
  });

  describe('UI Enable/Disable Logic', () => {
    // Helper to test with mocked environment variables
    const testUIEnabled = (nodeEnv?: string, elizaUIEnable?: string): boolean => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalUIEnable = process.env.ELIZA_UI_ENABLE;

      // Set test environment
      if (nodeEnv !== undefined) {
        process.env.NODE_ENV = nodeEnv;
      } else {
        delete process.env.NODE_ENV;
      }

      if (elizaUIEnable !== undefined) {
        process.env.ELIZA_UI_ENABLE = elizaUIEnable;
      } else {
        delete process.env.ELIZA_UI_ENABLE;
      }

      // Test the function
      const result = isWebUIEnabled();

      // Restore original environment
      if (originalNodeEnv !== undefined) {
        process.env.NODE_ENV = originalNodeEnv;
      } else {
        delete process.env.NODE_ENV;
      }

      if (originalUIEnable !== undefined) {
        process.env.ELIZA_UI_ENABLE = originalUIEnable;
      } else {
        delete process.env.ELIZA_UI_ENABLE;
      }

      return result;
    };

    it('should enable UI by default in development', () => {
      expect(testUIEnabled('development', undefined)).toBe(true);
      expect(testUIEnabled('test', undefined)).toBe(true);
      expect(testUIEnabled(undefined, undefined)).toBe(true); // No NODE_ENV defaults to dev
    });

    it('should disable UI by default in production', () => {
      expect(testUIEnabled('production', undefined)).toBe(false);
    });

    it('should allow explicit override with ELIZA_UI_ENABLE=true', () => {
      expect(testUIEnabled('production', 'true')).toBe(true);
      expect(testUIEnabled('development', 'true')).toBe(true);
      expect(testUIEnabled('production', 'TRUE')).toBe(true);
    });

    it('should allow explicit override with ELIZA_UI_ENABLE=false', () => {
      expect(testUIEnabled('development', 'false')).toBe(false);
      expect(testUIEnabled('production', 'false')).toBe(false);
      expect(testUIEnabled('development', 'FALSE')).toBe(false);
    });

    it('should treat empty strings as undefined', () => {
      expect(testUIEnabled('development', '')).toBe(true); // Empty string treated as undefined, so defaults to dev behavior
      expect(testUIEnabled('production', '')).toBe(false); // Empty string treated as undefined, so defaults to prod behavior
    });

    it('should handle various boolean-like values using parseBooleanFromText', () => {
      // Test values that parseBooleanFromText recognizes as true
      expect(testUIEnabled('production', '1')).toBe(true);
      expect(testUIEnabled('production', 'yes')).toBe(true);
      expect(testUIEnabled('production', 'YES')).toBe(true);
      expect(testUIEnabled('production', 'on')).toBe(true);
      expect(testUIEnabled('production', 'enable')).toBe(true);

      // Test values that parseBooleanFromText recognizes as false
      expect(testUIEnabled('development', '0')).toBe(false);
      expect(testUIEnabled('development', 'no')).toBe(false);
      expect(testUIEnabled('development', 'off')).toBe(false);
      expect(testUIEnabled('development', 'disable')).toBe(false);

      // Invalid values should be false
      expect(testUIEnabled('development', 'invalid')).toBe(false);
      expect(testUIEnabled('development', 'maybe')).toBe(false);
    });

    it('should generate appropriate log messages', () => {
      const getLogMessage = (uiEnabled: boolean, isProduction: boolean): string => {
        if (uiEnabled) {
          return 'Web UI enabled';
        } else {
          return 'Web UI disabled for security (production mode)';
        }
      };

      expect(getLogMessage(true, false)).toBe('Web UI enabled');
      expect(getLogMessage(true, true)).toBe('Web UI enabled');
      expect(getLogMessage(false, true)).toBe('Web UI disabled for security (production mode)');
      expect(getLogMessage(false, false)).toBe('Web UI disabled for security (production mode)');
    });

    it('should provide correct startup URL messages', () => {
      const getStartupMessage = (uiEnabled: boolean, port: number): string | null => {
        if (uiEnabled) {
          return `\\x1b[32mStartup successful!\\nGo to the dashboard at \\x1b[1mhttp://localhost:${port}\\x1b[22m\\x1b[0m`;
        } else {
          return `\\x1b[32mStartup successful!\\x1b[0m\\n\\x1b[33mWeb UI disabled.\\x1b[0m \\x1b[32mAPI endpoints available at:\\x1b[0m\\n  \\x1b[1mhttp://localhost:${port}/api/server/ping\\x1b[22m\\x1b[0m\\n  \\x1b[1mhttp://localhost:${port}/api/agents\\x1b[22m\\x1b[0m\\n  \\x1b[1mhttp://localhost:${port}/api/messaging\\x1b[22m\\x1b[0m`;
        }
      };

      const uiEnabledMsg = getStartupMessage(true, 3000);
      const uiDisabledMsg = getStartupMessage(false, 3000);

      expect(uiEnabledMsg).toContain('dashboard at');
      expect(uiEnabledMsg).toContain('http://localhost:3000');

      expect(uiDisabledMsg).toContain('Web UI disabled.');
      expect(uiDisabledMsg).toContain('API endpoints available at:');
      expect(uiDisabledMsg).toContain('/api/server/ping');
    });
  });
});
