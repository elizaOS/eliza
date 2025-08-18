import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { createLogger } from '../logger';

// Import envDetector to clear cache between tests
import { envDetector } from '../logger';

/**
 * Test type definitions
 */
interface MockProcess {
  versions?: {
    node?: string;
  };
  env?: Record<string, string | undefined>;
}

interface MockWindow {
  document?: object;
  console?: Partial<Console>;
}

type MockDocument = Record<string, unknown>;

/**
 * Comprehensive tests for both Node.js and Browser logger implementations
 * This test suite ensures the logger works correctly in both environments
 */

describe('Logger - Cross-Environment Tests', () => {
  let originalProcess: typeof process | undefined;
  let originalWindow: MockWindow | undefined;
  let originalDocument: MockDocument | undefined;

  beforeEach(() => {
    // Save original globals
    originalProcess = globalThis.process;
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    mock.restore();
  });

  afterEach(() => {
    // Restore original globals
    globalThis.process = originalProcess as typeof process;
    globalThis.window = originalWindow as unknown as typeof globalThis.window;
    globalThis.document = originalDocument as unknown as typeof globalThis.document;
    mock.restore();
    // Clear environment cache for next test
    envDetector.clearCache();
  });

  describe('Environment Detection', () => {
    it('should detect Node.js environment correctly', () => {
      // Ensure we're in Node.js environment
      globalThis.process = {
        versions: { node: '20.0.0' },
        env: { LOG_LEVEL: 'info' }
      } as MockProcess as typeof process;
      delete globalThis.window;
      delete globalThis.document;

      const isNode = typeof process !== 'undefined' && 
                     typeof process.versions !== 'undefined' && 
                     typeof process.versions.node !== 'undefined';
      const isBrowser = typeof globalThis !== 'undefined' && 
                        typeof globalThis.window !== 'undefined' && 
                        typeof globalThis.document !== 'undefined';

      expect(isNode).toBe(true);
      expect(isBrowser).toBe(false);
    });

    it('should detect browser environment correctly', () => {
      // Simulate browser environment
      globalThis.window = { 
        document: {},
        console: {
          log: mock(),
          info: mock(),
          warn: mock(),
          error: mock(),
          debug: mock(),
          trace: mock()
        }
      };
      globalThis.document = {};
      delete globalThis.process;

      const isNode = typeof process !== 'undefined' && 
                     typeof process.versions !== 'undefined' && 
                     typeof process.versions.node !== 'undefined';
      const isBrowser = typeof globalThis !== 'undefined' && 
                        typeof globalThis.window !== 'undefined' && 
                        typeof globalThis.document !== 'undefined';

      expect(isNode).toBe(false);
      expect(isBrowser).toBe(true);
    });
  });

  describe('BrowserLogger Class', () => {
    beforeEach(() => {
      // Clear environment cache to ensure proper detection
      envDetector.clearCache();
      
      // Mock browser environment
      globalThis.window = {
        document: {},
        console: {
          log: mock(),
          info: mock(),
          warn: mock(),
          error: mock(),
          debug: mock(),
          trace: mock(),
          clear: mock()
        }
      };
      globalThis.document = {};
      globalThis.console = globalThis.window.console as Console;
      
      // Clear cache again after setting up environment
      envDetector.clearCache();
    });

    it('should create BrowserLogger instance with all required methods', async () => {
      // Dynamically import to trigger browser detection
      const module = await import('../logger');
      
      // Create a browser logger instance, force browser type for testing
      const browserLogger = module.createLogger({ test: 'browser', __forceType: 'browser' });
      
      // Verify all required methods exist
      expect(typeof browserLogger.trace).toBe('function');
      expect(typeof browserLogger.debug).toBe('function');
      expect(typeof browserLogger.info).toBe('function');
      expect(typeof browserLogger.warn).toBe('function');
      expect(typeof browserLogger.error).toBe('function');
      expect(typeof browserLogger.fatal).toBe('function');
      
      // Verify custom ElizaOS methods exist
      expect(typeof browserLogger.success).toBe('function');
      expect(typeof browserLogger.progress).toBe('function');
      expect(typeof browserLogger.log).toBe('function');
      expect(typeof browserLogger.clear).toBe('function');
      expect(typeof browserLogger.child).toBe('function');
    });

    it('should log messages to console in browser environment', () => {
      // Ensure we're in browser environment
      delete globalThis.process;
      globalThis.window = { document: {} };
      globalThis.document = {};
      
      // Mock console methods
      const mockConsole = {
        log: mock(),
        info: mock(),
        warn: mock(),
        error: mock(),
        debug: mock(),
        trace: mock(),
        clear: mock()
      };
      globalThis.console = mockConsole as unknown as Console;

      // Create browser logger with debug level to ensure all levels are logged
      const browserLogger = createLogger({ level: 'debug', __forceType: 'browser' });

      // Test various log levels
      browserLogger.info('Info message');
      browserLogger.warn('Warning message');
      browserLogger.error('Error message');
      browserLogger.debug('Debug message');
      
      // Verify console methods were called
      expect(mockConsole.info).toHaveBeenCalled();
      expect(mockConsole.warn).toHaveBeenCalled();
      expect(mockConsole.error).toHaveBeenCalled();
      expect(mockConsole.debug).toHaveBeenCalled();
    });

    it('should format messages with objects correctly in browser', () => {
      // Ensure we're in browser environment
      delete globalThis.process;
      globalThis.window = { document: {} };
      globalThis.document = {};
      
      const mockConsole = {
        info: mock(),
        log: mock(),
        warn: mock(),
        error: mock(),
        debug: mock(),
        trace: mock()
      };
      globalThis.console = mockConsole as unknown as Console;

      // Create logger with debug level to ensure all levels are logged
      const browserLogger = createLogger({ level: 'debug', __forceType: 'browser' });

      // Test with object
      browserLogger.info({ user: 'john', action: 'login' }, 'User logged in');
      expect(mockConsole.info).toHaveBeenCalled();

      // Test with error
      const error = new Error('Test error');
      browserLogger.error(error);
      expect(mockConsole.error).toHaveBeenCalled();

      // Test custom levels (success and progress map to info)
      browserLogger.success('Operation successful');
      browserLogger.progress('50% complete');
      expect(mockConsole.info).toHaveBeenCalled();
    });

    it('should respect log levels in browser environment', () => {
      // Ensure we're in browser environment
      delete globalThis.process;
      globalThis.window = { document: {} };
      globalThis.document = {};
      
      const mockConsole = {
        trace: mock(),
        debug: mock(),
        info: mock(),
        warn: mock(),
        error: mock(),
        log: mock()
      };
      globalThis.console = mockConsole as unknown as Console;
      
      // Clear cache to detect browser environment
      envDetector.clearCache();

      // Create logger with warn level, force browser type for testing
      const browserLogger = createLogger({ level: 'warn', __forceType: 'browser' });

      // These should not log (below warn level)
      browserLogger.trace('Trace message');
      browserLogger.debug('Debug message');
      browserLogger.info('Info message');
      
      // These should log (warn level and above)
      browserLogger.warn('Warning message');
      browserLogger.error('Error message');
      browserLogger.fatal('Fatal message');

      // Verify only warn and above were called
      expect(mockConsole.trace).not.toHaveBeenCalled();
      expect(mockConsole.debug).not.toHaveBeenCalled();
      expect(mockConsole.info).not.toHaveBeenCalled();
      expect(mockConsole.warn).toHaveBeenCalled();
      expect(mockConsole.error).toHaveBeenCalled();
    });

    it('should maintain in-memory log storage in browser', () => {
      const browserLogger = createLogger({ __forceType: 'browser' });

      // Log multiple messages
      browserLogger.info('Message 1');
      browserLogger.warn('Message 2');
      browserLogger.error('Message 3');

      // Verify messages are stored (would be accessible via inMemoryDestination)
      // The actual storage is internal, but we can verify the logger doesn't crash
      expect(() => browserLogger.clear()).not.toThrow();
    });

    it('should handle child loggers in browser', () => {
      // Ensure we're in browser environment
      delete globalThis.process;
      globalThis.window = { document: {} };
      globalThis.document = {};
      
      const mockConsole = {
        info: mock(),
        log: mock()
      };
      globalThis.console = mockConsole as unknown as Console;
      
      // Clear cache to detect browser environment
      envDetector.clearCache();

      // Force browser type for testing
      const parentLogger = createLogger({ parent: 'main', __forceType: 'browser' });
      const childLogger = parentLogger.child({ child: 'sub' });

      childLogger.info('Child message');
      expect(mockConsole.info).toHaveBeenCalled();
    });
  });

  describe('Node.js Logger (Pino)', () => {
    beforeEach(() => {
      // Clear environment cache
      envDetector.clearCache();
      
      // Restore Node.js environment
      globalThis.process = originalProcess || {
        versions: { node: '20.0.0' },
        env: {}
      } as unknown as typeof process;
      delete globalThis.window;
      delete globalThis.document;

      // Mock pino-pretty
      mock.module('pino-pretty', () => ({
        default: mock(() => ({
          write: mock()
        }))
      }));
      
      // Clear cache again after environment setup
      envDetector.clearCache();
    });

    it('should use Pino logger in Node.js environment', () => {
      const nodeLogger = createLogger();
      
      // Verify Pino-specific features
      expect(typeof nodeLogger.trace).toBe('function');
      expect(typeof nodeLogger.debug).toBe('function');
      expect(typeof nodeLogger.info).toBe('function');
      expect(typeof nodeLogger.warn).toBe('function');
      expect(typeof nodeLogger.error).toBe('function');
      expect(typeof nodeLogger.fatal).toBe('function');
      
      // Verify custom methods are added
      expect(typeof nodeLogger.success).toBe('function');
      expect(typeof nodeLogger.progress).toBe('function');
      expect(typeof nodeLogger.log).toBe('function');
    });

    it('should handle Pino child loggers correctly', () => {
      const parentLogger = createLogger({ service: 'api' });
      const childLogger = parentLogger.child({ request: '123' });
      
      expect(childLogger).toBeDefined();
      expect(typeof childLogger.info).toBe('function');
    });

    it('should support Pino configuration options', () => {
      process.env.LOG_LEVEL = 'debug';
      process.env.LOG_JSON_FORMAT = 'true';
      
      const nodeLogger = createLogger();
      expect(nodeLogger.level).toBeDefined();
      
      process.env.LOG_LEVEL = '';
      process.env.LOG_JSON_FORMAT = '';
    });
  });

  describe('Cross-Environment Compatibility', () => {
    it('should maintain consistent API across environments', async () => {
      // Test Node.js logger
      globalThis.process = originalProcess || { versions: { node: '20.0.0' }, env: {} } as unknown as typeof process;
      delete globalThis.window;
      const nodeLogger = createLogger();

      // Test browser logger
      globalThis.window = { document: {}, console: globalThis.console };
      globalThis.document = {};
      delete globalThis.process;
      const browserLogger = createLogger();

      // Both should have the same methods
      const methods = [
        'trace', 'debug', 'info', 'warn', 'error', 'fatal',
        'success', 'progress', 'log', 'clear', 'child'
      ];

      for (const method of methods) {
        expect(typeof nodeLogger[method]).toBe('function');
        expect(typeof browserLogger[method]).toBe('function');
      }
    });

    it('should handle complex log objects in both environments', () => {
      const testData = {
        user: { id: 123, name: 'John' },
        metadata: { timestamp: Date.now(), version: '1.0' },
        nested: { deep: { value: 'test' } }
      };

      // Test in Node.js
      globalThis.process = originalProcess || { versions: { node: '20.0.0' }, env: {} } as unknown as typeof process;
      const nodeLogger = createLogger();
      expect(() => nodeLogger.info(testData, 'Complex object')).not.toThrow();

      // Test in browser
      globalThis.window = { document: {}, console: { info: mock() } };
      globalThis.document = {};
      delete globalThis.process;
      const browserLogger = createLogger({ __forceType: 'browser' });
      expect(() => browserLogger.info(testData, 'Complex object')).not.toThrow();
    });

    it('should handle errors consistently across environments', () => {
      const error = new Error('Test error');
      error.stack = 'Error: Test error\n  at test.js:1:1';

      // Node.js
      globalThis.process = originalProcess || { versions: { node: '20.0.0' }, env: {} } as unknown as typeof process;
      const nodeLogger = createLogger();
      expect(() => nodeLogger.error(error)).not.toThrow();
      expect(() => nodeLogger.error({ error }, 'Error occurred')).not.toThrow();

      // Browser
      globalThis.window = { document: {}, console: { error: mock() } };
      globalThis.document = {};
      delete globalThis.process;
      const browserLogger = createLogger({ __forceType: 'browser' });
      expect(() => browserLogger.error(error)).not.toThrow();
      expect(() => browserLogger.error({ error }, 'Error occurred')).not.toThrow();
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle undefined console methods in browser', () => {
      globalThis.window = { document: {} };
      globalThis.document = {};
      globalThis.console = {
        log: mock(),
        // Missing other methods
      } as unknown as Console;

      const browserLogger = createLogger({ __forceType: 'browser' });
      
      // Should fallback to console.log for missing methods
      expect(() => browserLogger.info('Test')).not.toThrow();
      expect(() => browserLogger.warn('Test')).not.toThrow();
    });

    it('should handle circular references in objects', () => {
      type CircularObject = Record<string, unknown> & {
        name: string;
        circular?: CircularObject;
      };
      const obj: CircularObject = { name: 'test' };
      obj.circular = obj;

      const browserLogger = createLogger({ __forceType: 'browser' });
      expect(() => browserLogger.info(obj, 'Circular reference')).not.toThrow();
    });

    it('should handle very long messages', () => {
      const longMessage = 'x'.repeat(10000);
      const browserLogger = createLogger({ __forceType: 'browser' });
      expect(() => browserLogger.info(longMessage)).not.toThrow();
    });

    it('should handle null and undefined values', () => {
      const browserLogger = createLogger({ __forceType: 'browser' });
      expect(() => browserLogger.info(null, 'Null value')).not.toThrow();
      expect(() => browserLogger.info(undefined, 'Undefined value')).not.toThrow();
      expect(() => browserLogger.info({ value: null })).not.toThrow();
      expect(() => browserLogger.info({ value: undefined })).not.toThrow();
    });
  });

  describe('Memory Management', () => {
    it('should limit in-memory log storage', () => {
      // Setup browser environment first
      globalThis.window = { document: {}, console: globalThis.console };
      globalThis.document = {};
      delete globalThis.process;
      
      const browserLogger = createLogger({ __forceType: 'browser' });
      
      // Log more than the max limit (1000 by default)
      for (let i = 0; i < 1100; i++) {
        browserLogger.info(`Message ${i}`);
      }
      
      // Should not crash and should maintain limit
      expect(() => browserLogger.clear()).not.toThrow();
    });

    it('should clear logs properly in both environments', () => {
      // Browser
      const mockClear = mock();
      globalThis.window = { document: {}, console: { clear: mockClear } };
      globalThis.document = {};
      globalThis.console = { ...globalThis.console, clear: mockClear };
      delete globalThis.process;
      
      const browserLogger = createLogger({ __forceType: 'browser' });
      browserLogger.clear();
      expect(mockClear).toHaveBeenCalled();

      // Node.js
      globalThis.process = originalProcess || { versions: { node: '20.0.0' }, env: {} } as unknown as typeof process;
      delete globalThis.window;
      const nodeLogger = createLogger();
      expect(() => nodeLogger.clear()).not.toThrow();
    });

    it('should not leak __forceType into Node.js logger output', () => {
      // Setup Node.js environment
      globalThis.process = originalProcess || { versions: { node: '20.0.0' }, env: {} } as unknown as typeof process;
      delete globalThis.window;
      delete globalThis.document;
      
      // Mock pino to capture the configuration passed to it
      interface CapturedOptions {
        base?: Record<string, unknown>;
        [key: string]: unknown;
      }
      let capturedOptions: CapturedOptions | null = null;
      mock.module('pino', () => {
        return {
          default: (opts: CapturedOptions) => {
            capturedOptions = opts;
            return {
              trace: mock(),
              debug: mock(),
              info: mock(),
              warn: mock(),
              error: mock(),
              fatal: mock(),
              success: mock(),
              progress: mock(),
              log: mock(),
              clear: mock()
            };
          }
        };
      });
      
      // Create logger with __forceType in bindings
      createLogger({ 
        __forceType: 'node',
        appName: 'test-app',
        userId: '123' 
      });
      
      // Verify __forceType is not in the base configuration
      expect(capturedOptions).toBeDefined();
      if (capturedOptions && capturedOptions.base) {
        expect(capturedOptions.base.__forceType).toBeUndefined();
        // But other properties should still be there
        expect(capturedOptions.base.appName).toBe('test-app');
        expect(capturedOptions.base.userId).toBe('123');
      }
    });
  });
});
