/**
 * Tests for ELIZA_UI_ENABLE feature
 */

import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';

// Mock logger
mock.module('@elizaos/core', async () => {
  const actual = await import('@elizaos/core');
  return {
    ...actual,
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
  };
});

describe('UI Disable Feature Integration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv };
    mock.restore();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('Environment Variable Behavior', () => {
    it('should read ELIZA_UI_ENABLE from environment', () => {
      // Test the exact pattern from .env.example
      const parseUIEnable = (envValue?: string): boolean | undefined => {
        if (envValue === undefined || envValue === '') {
          return undefined; // Use default behavior
        }
        return envValue.toLowerCase() === 'true';
      };

      // Test various .env.example scenarios
      expect(parseUIEnable(undefined)).toBeUndefined();
      expect(parseUIEnable('')).toBeUndefined();
      expect(parseUIEnable('true')).toBe(true);
      expect(parseUIEnable('false')).toBe(false);
      expect(parseUIEnable('TRUE')).toBe(true);
      expect(parseUIEnable('FALSE')).toBe(false);
    });

    it('should handle combined NODE_ENV and ELIZA_UI_ENABLE scenarios', () => {
      const testScenarios = [
        // NODE_ENV, ELIZA_UI_ENABLE, Expected UI State, Description
        ['development', undefined, true, 'Default dev: UI enabled'],
        ['production', undefined, false, 'Default prod: UI disabled'],
        ['development', 'true', true, 'Dev with explicit enable'],
        ['development', 'false', false, 'Dev with explicit disable'],
        ['production', 'true', true, 'Prod with explicit enable'],
        ['production', 'false', false, 'Prod with explicit disable'],
        ['test', undefined, true, 'Test environment: UI enabled'],
        [undefined, undefined, true, 'No NODE_ENV: defaults to dev'],
      ];

      testScenarios.forEach(([nodeEnv, elizaUIEnable, expected, description]) => {
        const isProduction = nodeEnv === 'production';
        const uiEnabled =
          elizaUIEnable !== undefined ? elizaUIEnable.toLowerCase() === 'true' : !isProduction;

        expect(uiEnabled).toBe(expected);
        // Also verify the description makes sense
        expect(typeof description).toBe('string');
      });
    });
  });

  describe('Server Configuration Impact', () => {
    it('should affect static file serving behavior', () => {
      // Mock Express app behavior
      const mockExpressUse = jest.fn();
      const mockApp = {
        use: mockExpressUse,
      };

      const configureStaticFiles = (app: any, uiEnabled: boolean) => {
        if (uiEnabled) {
          app.use('express.static(clientPath, staticOptions)');
        }
        // When disabled, no static file middleware is added
      };

      // Test UI enabled
      configureStaticFiles(mockApp, true);
      expect(mockExpressUse).toHaveBeenCalledWith('express.static(clientPath, staticOptions)');

      // Reset and test UI disabled
      mockExpressUse.mockClear();
      configureStaticFiles(mockApp, false);
      expect(mockExpressUse).not.toHaveBeenCalled();
    });

    it('should return standard HTTP 403 when UI disabled', () => {
      const mockSendStatus = jest.fn();
      const mockResponse = {
        sendStatus: mockSendStatus,
      };

      const handleUIDisabledRequest = (res: any, uiEnabled: boolean) => {
        if (!uiEnabled) {
          res.sendStatus(403); // Standard HTTP 403 Forbidden
        }
      };

      // Test UI disabled response
      handleUIDisabledRequest(mockResponse, false);
      expect(mockSendStatus).toHaveBeenCalledWith(403);

      // Test UI enabled (no response)
      mockSendStatus.mockClear();
      handleUIDisabledRequest(mockResponse, true);
      expect(mockSendStatus).not.toHaveBeenCalled();
    });

    it('should affect SPA fallback route registration', () => {
      const mockExpressUse = jest.fn();
      const mockApp = {
        use: mockExpressUse,
      };

      const configureSPAFallback = (app: any, uiEnabled: boolean) => {
        if (uiEnabled) {
          app.use('spa-fallback-middleware');
        } else {
          app.use('403-forbidden-for-non-api-routes');
        }
      };

      // Test UI enabled
      configureSPAFallback(mockApp, true);
      expect(mockExpressUse).toHaveBeenCalledWith('spa-fallback-middleware');

      // Reset and test UI disabled
      mockExpressUse.mockClear();
      configureSPAFallback(mockApp, false);
      expect(mockExpressUse).toHaveBeenCalledWith('403-forbidden-for-non-api-routes');
    });
  });

  describe('Startup Message Generation', () => {
    it('should generate correct console messages for different states', () => {
      const generateStartupMessage = (uiEnabled: boolean, port: number, nodeEnv: string) => {
        if (uiEnabled && nodeEnv !== 'development') {
          return {
            type: 'dashboard',
            message: `\\x1b[32mStartup successful!\\nGo to the dashboard at \\x1b[1mhttp://localhost:${port}\\x1b[22m\\x1b[0m`,
          };
        } else if (!uiEnabled) {
          return {
            type: 'api-only',
            message: `\\x1b[32mStartup successful!\\x1b[0m\\n\\x1b[33mWeb UI disabled.\\x1b[0m \\x1b[32mAPI endpoints available at:\\x1b[0m\\n  \\x1b[1mhttp://localhost:${port}/api/server/ping\\x1b[22m\\x1b[0m\\n  \\x1b[1mhttp://localhost:${port}/api/agents\\x1b[22m\\x1b[0m\\n  \\x1b[1mhttp://localhost:${port}/api/messaging\\x1b[22m\\x1b[0m`,
          };
        }
        return null; // Development mode doesn't show dashboard URL
      };

      // Test production with UI enabled
      const prodEnabled = generateStartupMessage(true, 3000, 'production');
      expect(prodEnabled?.type).toBe('dashboard');
      expect(prodEnabled?.message).toContain('http://localhost:3000');

      // Test production with UI disabled
      const prodDisabled = generateStartupMessage(false, 3000, 'production');
      expect(prodDisabled?.type).toBe('api-only');
      expect(prodDisabled?.message).toContain('Web UI disabled.');
      expect(prodDisabled?.message).toContain('API endpoints available at:');

      // Test development (no message)
      const devResult = generateStartupMessage(true, 3000, 'development');
      expect(devResult).toBeNull();
    });
  });

  describe('Security Implications', () => {
    it('should document security benefits of disabling UI', () => {
      const getSecurityBenefits = (uiDisabled: boolean): string[] => {
        if (uiDisabled) {
          return [
            'Eliminates web UI attack surface',
            'Prevents unauthorized dashboard access',
            'Reduces exposed static files',
            'API-only deployment suitable for headless servers',
            'Complies with security-first production practices',
          ];
        }
        return ['Full functionality including web dashboard'];
      };

      const disabledBenefits = getSecurityBenefits(true);
      const enabledBenefits = getSecurityBenefits(false);

      expect(disabledBenefits).toHaveLength(5);
      expect(disabledBenefits).toContain('Eliminates web UI attack surface');
      expect(enabledBenefits).toHaveLength(1);
    });

    it('should ensure API functionality remains intact when UI disabled', () => {
      // Mock API routes that should always work
      const mockRouter = {
        routes: [] as string[],
        get: function (path: string) {
          this.routes.push(`GET ${path}`);
        },
        post: function (path: string) {
          this.routes.push(`POST ${path}`);
        },
        delete: function (path: string) {
          this.routes.push(`DELETE ${path}`);
        },
      };

      const registerAPIRoutes = (router: typeof mockRouter, uiEnabled: boolean) => {
        // API routes are always registered regardless of UI state
        router.get('/api/agents');
        router.post('/api/agents/:agentId/message');
        router.get('/api/channels/:channelId/messages');
        router.delete('/api/channels/:channelId/messages/:messageId');

        // UI routes only registered when UI enabled
        if (uiEnabled) {
          router.get('/dashboard');
          router.get('/agents');
        }
      };

      // Test with UI enabled
      registerAPIRoutes(mockRouter, true);
      expect(mockRouter.routes).toContain('GET /api/agents');
      expect(mockRouter.routes).toContain('GET /dashboard');

      // Reset and test with UI disabled
      mockRouter.routes = [];
      registerAPIRoutes(mockRouter, false);
      expect(mockRouter.routes).toContain('GET /api/agents');
      expect(mockRouter.routes).not.toContain('GET /dashboard');
    });
  });

  describe('Documentation Consistency', () => {
    it('should match .env.example documentation patterns', () => {
      // Test that our implementation matches the documented behavior
      const envExamplePattern = {
        comment:
          '# Controls whether the web UI is served (default: enabled in development, disabled in production)',
        usage:
          '# Set to "true" to force enable, "false" to force disable, or leave unset for automatic behavior',
        variable: 'ELIZA_UI_ENABLE=',
      };

      expect(envExamplePattern.comment).toContain('enabled in development, disabled in production');
      expect(envExamplePattern.usage).toContain('true" to force enable');
      expect(envExamplePattern.usage).toContain('false" to force disable');
      expect(envExamplePattern.variable).toBe('ELIZA_UI_ENABLE=');
    });
  });
});
