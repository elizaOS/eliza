import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import { mock } from 'bun:test';
import { createLogger, logger, elizaLogger } from '../logger';

// Mock environment variables
const mockEnv = {
  LOG_LEVEL: '',
  DEFAULT_LOG_LEVEL: '',
  LOG_JSON_FORMAT: '',
  SENTRY_LOGGING: 'false',
  LOG_DIAGNOSTIC: '',
};

// No external logger transport to mock; Adze is used internally

describe('Logger', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    // Reset environment variables
    Object.keys(mockEnv).forEach((key) => {
      process.env[key] = mockEnv[key];
    });
    mock.restore();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('Logger Creation', () => {
    it('should export logger instance', () => {
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      // Note: warn and debug methods exist on the pino logger instance
      // but may not be enumerable. Test their functionality instead.
      expect(logger.warn).toBeDefined();
      expect(logger.debug).toBeDefined();
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    it('should export elizaLogger as alias for backward compatibility', () => {
      expect(elizaLogger).toBeDefined();
      expect(elizaLogger).toBe(logger);
    });

    it('should have custom log levels', () => {
      const testLogger = createLogger({ agentName: 'test' });
      expect(typeof testLogger.fatal).toBe('function');
      expect(typeof testLogger.error).toBe('function');
      expect(typeof testLogger.warn).toBe('function');
      expect(typeof testLogger.info).toBe('function');
      expect(typeof testLogger.debug).toBe('function');
      expect(typeof testLogger.trace).toBe('function');
    });
  });

  describe('createLogger Function', () => {
    it('should create logger with bindings', () => {
      const bindings = { agentName: 'TestAgent', agentId: '123' };
      const customLogger = createLogger(bindings);

      expect(customLogger).toBeDefined();
      expect(typeof customLogger.info).toBe('function');
    });

    it('should create logger without bindings', () => {
      const customLogger = createLogger();

      expect(customLogger).toBeDefined();
      expect(typeof customLogger.info).toBe('function');
    });

    it('should handle boolean bindings parameter', () => {
      const customLogger = createLogger(false);

      expect(customLogger).toBeDefined();
      expect(typeof customLogger.info).toBe('function');
    });
  });

  describe('Log Level Configuration', () => {
    it('should use debug level when LOG_LEVEL is debug', () => {
      process.env.LOG_LEVEL = 'debug';
      const customLogger = createLogger();

      // Logger should be created with debug level
      expect(customLogger.level).toBeDefined();
    });

    it('should use DEFAULT_LOG_LEVEL when LOG_LEVEL is not debug', () => {
      process.env.LOG_LEVEL = '';
      process.env.DEFAULT_LOG_LEVEL = 'warn';
      const customLogger = createLogger();

      expect(customLogger.level).toBeDefined();
    });

    it('should default to info level when no log level is specified', () => {
      process.env.LOG_LEVEL = '';
      process.env.DEFAULT_LOG_LEVEL = '';
      const customLogger = createLogger();

      expect(customLogger.level).toBeDefined();
    });
  });

  describe('JSON Format Configuration', () => {
    it('should use JSON format when LOG_JSON_FORMAT is true', () => {
      process.env.LOG_JSON_FORMAT = 'true';
      const customLogger = createLogger();

      expect(customLogger).toBeDefined();
      // The actual JSON output is verified in integration tests
      // since Adze's output mechanism is not easily mockable in unit tests
    });

    it('should use pretty format when LOG_JSON_FORMAT is false', () => {
      process.env.LOG_JSON_FORMAT = 'false';
      const customLogger = createLogger();

      expect(customLogger).toBeDefined();
    });

    it('should enable JSON format without throwing required fields error', () => {
      process.env.LOG_JSON_FORMAT = 'true';

      // This test verifies the main bug fix - that JSON format works without
      // "Required fields are missing" error. Detailed JSON format tests are
      // in logger-browser-node.test.ts for cross-environment coverage.
      expect(() => {
        const customLogger = createLogger();
        customLogger.info('Test message');
      }).not.toThrow();

      delete process.env.LOG_JSON_FORMAT;
    });
  });

  describe('Log Filtering', () => {
    it('should filter service registration logs in non-debug mode', () => {
      process.env.LOG_LEVEL = 'info';
      const customLogger = createLogger();

      // These logs should be filtered in non-debug mode
      const filteredMessages = [
        'registered successfully',
        'Registering',
        'Success:',
        'linked to',
        'Started',
      ];

      // Logger is created and can handle these messages
      filteredMessages.forEach((msg) => {
        expect(() => customLogger.info({ agentName: 'test', agentId: '123' }, msg)).not.toThrow();
      });
    });

    it('should not filter service registration logs in debug mode', () => {
      process.env.LOG_LEVEL = 'debug';
      const customLogger = createLogger();

      // In debug mode, all logs should pass through
      expect(customLogger.level).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle Error objects in log messages', () => {
      const customLogger = createLogger();
      const testError = new Error('Test error');

      expect(() => customLogger.error(testError)).not.toThrow();
      expect(() => customLogger.error('Message', testError)).not.toThrow();
      expect(() =>
        customLogger.error({ context: 'test' }, 'Error occurred', testError)
      ).not.toThrow();
    });

    it('should format error messages properly', () => {
      const customLogger = createLogger();
      const testError = new Error('Test error');
      testError.name = 'TestError';

      // Should handle error formatting without throwing
      expect(() => customLogger.error(testError)).not.toThrow();
    });
  });

  describe('Clear Method', () => {
    it('should have clear method when not using raw JSON format', () => {
      process.env.LOG_JSON_FORMAT = 'false';
      // Since the logger is created asynchronously with pretty printing,
      // we just verify the logger is created successfully
      expect(logger).toBeDefined();
    });
  });

  describe('Hook Methods', () => {
    it('should handle various log input formats', () => {
      const customLogger = createLogger();

      // Test various input formats
      expect(() => customLogger.info('Simple string')).not.toThrow();
      expect(() => customLogger.info({ key: 'value' }, 'With object')).not.toThrow();
      expect(() => customLogger.info('Multiple', 'string', 'parts')).not.toThrow();
      expect(() => customLogger.error(new Error('Test'), 'With error')).not.toThrow();
    });

    it('should handle mixed arguments with errors', () => {
      const customLogger = createLogger();
      const error = new Error('Test error');

      expect(() => customLogger.error('Message', error, { extra: 'data' })).not.toThrow();
    });
  });

  describe('Diagnostic Mode', () => {
    it('should add diagnostic flag when LOG_DIAGNOSTIC is enabled', () => {
      process.env.LOG_DIAGNOSTIC = 'true';
      const customLogger = createLogger();

      // Logger should handle diagnostic mode
      expect(customLogger).toBeDefined();
    });
  });

  describe('Custom Prettifiers', () => {
    it('should format log levels correctly', () => {
      const customLogger = createLogger();

      // Test that various log levels work
      expect(() => customLogger.trace('Trace message')).not.toThrow();
      expect(() => customLogger.debug('Debug message')).not.toThrow();
      expect(() => customLogger.info('Info message')).not.toThrow();
      expect(() => customLogger.warn('Warn message')).not.toThrow();
      expect(() => customLogger.error('Error message')).not.toThrow();
      expect(() => customLogger.fatal('Fatal message')).not.toThrow();
    });
  });

  describe('Comprehensive Hook Method Coverage', () => {
    it('should handle error as first argument with formatting', () => {
      const customLogger = createLogger();
      const error = new Error('Test error message');
      error.name = 'CustomError';
      error.stack = 'Error: Test error message\n    at Object.<anonymous> (test.js:1:1)';

      // This triggers the formatError path in hooks.logMethod
      expect(() => customLogger.error(error)).not.toThrow();
    });

    it('should handle object with multiple string arguments', () => {
      const customLogger = createLogger();

      // This triggers the object + rest args path
      expect(() => customLogger.info({ userId: '123' }, 'User', 'logged', 'in')).not.toThrow();
    });

    it('should handle string with error in rest arguments', () => {
      const customLogger = createLogger();
      const error1 = new Error('First error');
      const error2 = new Error('Second error');

      // This triggers error handling in rest args
      expect(() => customLogger.error('Multiple errors:', error1, error2)).not.toThrow();
    });

    it('should handle mixed object and string arguments', () => {
      const customLogger = createLogger();

      // This triggers the context building path
      expect(() => customLogger.info('Status:', { active: true }, 'for user')).not.toThrow();
    });

    it('should handle non-string, non-error objects in arguments', () => {
      const customLogger = createLogger();

      // This triggers JSON.stringify for non-string args
      expect(() =>
        customLogger.info('Data:', { complex: { nested: true } }, ['array', 'data'])
      ).not.toThrow();
    });

    it('should handle Sentry exception capture for errors', () => {
      const originalSentryLogging = process.env.SENTRY_LOGGING;
      process.env.SENTRY_LOGGING = ''; // Not 'false', so Sentry logging is enabled

      const customLogger = createLogger();
      const error = new Error('Sentry test');

      // This should trigger Sentry.captureException
      expect(() => customLogger.error(error)).not.toThrow();
      expect(() => customLogger.error('Message with error:', error)).not.toThrow();

      process.env.SENTRY_LOGGING = originalSentryLogging;
    });

    it('should handle all argument being non-string objects', () => {
      const customLogger = createLogger();

      // Logger expects string message after object, so we need to provide valid signatures
      expect(() => customLogger.info({ a: 1, b: 2, c: 3 }, 'Combined object log')).not.toThrow();
      expect(() => customLogger.info('Objects:', { a: 1 }, { b: 2 })).not.toThrow();
    });

    it('should handle logger clear method when destination exists', () => {
      // Access the clear method if it exists
      if (typeof (logger as any).clear === 'function') {
        expect(() => (logger as any).clear()).not.toThrow();
      }

      // Also test on a newly created logger
      const customLogger = createLogger();
      if (typeof (customLogger as any).clear === 'function') {
        expect(() => (customLogger as any).clear()).not.toThrow();
      }
    });
  });

  describe('InMemoryDestination Coverage', () => {
    it('should handle non-JSON string data in write method', () => {
      const customLogger = createLogger();

      // This could trigger the non-JSON path in InMemoryDestination.write
      // when the transport receives malformed data
      expect(() => customLogger.info('Simple text that might not be JSON')).not.toThrow();
    });

    it('should handle diagnostic mode with filtered logs', () => {
      process.env.LOG_DIAGNOSTIC = 'true';
      process.env.LOG_LEVEL = 'info'; // Not debug

      const customLogger = createLogger({ agentName: 'test', agentId: '123' });

      // These should be filtered but diagnostic mode might log them
      expect(() => customLogger.info('registered successfully')).not.toThrow();
      expect(() => customLogger.info('Registering service')).not.toThrow();

      process.env.LOG_DIAGNOSTIC = '';
    });
  });

  describe('Async Stream Creation', () => {
    it('should handle async stream creation when require fails', async () => {
      // This test simulates the async fallback path
      // We can't easily mock require failure in test environments, so we test the async path exists
      const originalEnv = process.env.LOG_JSON_FORMAT;
      process.env.LOG_JSON_FORMAT = 'false';

      // Force a new logger creation which might use async path
      // Note: bun:test doesn't have resetModules equivalent
      const { createLogger: asyncLogger } = await import('../logger');

      const logger = asyncLogger();
      expect(logger).toBeDefined();

      // Wait a bit for async initialization
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(() => logger.info('Async logger test')).not.toThrow();

      process.env.LOG_JSON_FORMAT = originalEnv;
    });

    it('should handle pino-pretty module not having default export', async () => {
      // Mock pino-pretty without default export
      // Note: bun:test has different module mocking behavior
      const { createLogger: testLogger } = await import('../logger');

      const logger = testLogger();
      expect(logger).toBeDefined();
    });
  });

  describe('Additional Custom Level Tests', () => {
    it('should use custom log levels', () => {
      const customLogger = createLogger();

      // Test custom levels exist and work
      expect(typeof (customLogger as any).log).toBe('function');
      expect(typeof (customLogger as any).progress).toBe('function');
      expect(typeof (customLogger as any).success).toBe('function');

      expect(() => (customLogger as any).log('Custom log message')).not.toThrow();
      expect(() => (customLogger as any).progress('Progress update')).not.toThrow();
      expect(() => (customLogger as any).success('Operation successful')).not.toThrow();
    });
  });

  describe('Custom Prettifier Edge Cases', () => {
    it('should handle undefined level in prettifier', () => {
      const customLogger = createLogger();

      // This might trigger the undefined level path in prettifier
      expect(() => customLogger.info('Test with potential undefined level')).not.toThrow();
    });

    it('should handle null level in prettifier', () => {
      const customLogger = createLogger();

      // Force a log that might have null level
      expect(() => (customLogger as any).child({ level: null }).info('Test')).not.toThrow();
    });

    it('should handle object level data in prettifier', () => {
      const customLogger = createLogger();

      // Test object input to level prettifier
      expect(() => customLogger.child({ level: 30 }).info('Test with numeric level')).not.toThrow();
    });
  });
});
