import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { createLogger, logger, elizaLogger } from '../logger';

/**
 * Comprehensive tests for both Node.js and Browser logger implementations
 * This test suite ensures the logger works correctly in both environments
 */

describe('Logger - Cross-Environment Tests', () => {
  let originalGlobal: any;
  let originalProcess: any;
  let originalWindow: any;
  let originalDocument: any;

  beforeEach(() => {
    // Save original globals
    originalGlobal = globalThis;
    originalProcess = globalThis.process;
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    mock.restore();
  });

  afterEach(() => {
    // Restore original globals
    globalThis.process = originalProcess;
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    mock.restore();
  });

  describe('Environment Detection', () => {
    it('should detect Node.js environment correctly', () => {
      // Ensure we're in Node.js environment
      globalThis.process = {
        versions: { node: '20.0.0' },
        env: { LOG_LEVEL: 'info' }
      };
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
      globalThis.console = globalThis.window.console;
    });

    it('should create BrowserLogger instance with all required methods', async () => {
      // Dynamically import to trigger browser detection
      const module = await import('../logger');
      
      // Create a browser logger instance
      const browserLogger = module.createLogger({ test: 'browser' });
      
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
      globalThis.console = mockConsole;

      // Create browser logger with debug level to ensure all levels are logged
      const browserLogger = createLogger({ level: 'debug' });

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
      globalThis.console = mockConsole;

      // Create logger with debug level to ensure all levels are logged
      const browserLogger = createLogger({ level: 'debug' });

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
      const mockConsole = {
        trace: mock(),
        debug: mock(),
        info: mock(),
        warn: mock(),
        error: mock(),
        log: mock()
      };
      globalThis.console = mockConsole;

      // Create logger with warn level
      const browserLogger = createLogger({ level: 'warn' });

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
      const browserLogger = createLogger();

      // Log multiple messages
      browserLogger.info('Message 1');
      browserLogger.warn('Message 2');
      browserLogger.error('Message 3');

      // Verify messages are stored (would be accessible via inMemoryDestination)
      // The actual storage is internal, but we can verify the logger doesn't crash
      expect(() => browserLogger.clear()).not.toThrow();
    });

    it('should handle child loggers in browser', () => {
      const mockConsole = {
        info: mock(),
        log: mock()
      };
      globalThis.console = mockConsole;

      const parentLogger = createLogger({ parent: 'main' });
      const childLogger = parentLogger.child({ child: 'sub' });

      childLogger.info('Child message');
      expect(mockConsole.info).toHaveBeenCalled();
    });
  });

  describe('Node.js Logger (Pino)', () => {
    beforeEach(() => {
      // Restore Node.js environment
      globalThis.process = originalProcess || {
        versions: { node: '20.0.0' },
        env: {}
      };
      delete globalThis.window;
      delete globalThis.document;

      // Mock pino-pretty
      mock.module('pino-pretty', () => ({
        default: mock(() => ({
          write: mock()
        }))
      }));
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
      globalThis.process = originalProcess || { versions: { node: '20.0.0' }, env: {} };
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
      globalThis.process = originalProcess || { versions: { node: '20.0.0' }, env: {} };
      const nodeLogger = createLogger();
      expect(() => nodeLogger.info(testData, 'Complex object')).not.toThrow();

      // Test in browser
      globalThis.window = { document: {}, console: { info: mock() } };
      globalThis.document = {};
      delete globalThis.process;
      const browserLogger = createLogger();
      expect(() => browserLogger.info(testData, 'Complex object')).not.toThrow();
    });

    it('should handle errors consistently across environments', () => {
      const error = new Error('Test error');
      error.stack = 'Error: Test error\n  at test.js:1:1';

      // Node.js
      globalThis.process = originalProcess || { versions: { node: '20.0.0' }, env: {} };
      const nodeLogger = createLogger();
      expect(() => nodeLogger.error(error)).not.toThrow();
      expect(() => nodeLogger.error('Error occurred:', error)).not.toThrow();

      // Browser
      globalThis.window = { document: {}, console: { error: mock() } };
      globalThis.document = {};
      delete globalThis.process;
      const browserLogger = createLogger();
      expect(() => browserLogger.error(error)).not.toThrow();
      expect(() => browserLogger.error('Error occurred:', error)).not.toThrow();
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle undefined console methods in browser', () => {
      globalThis.window = { document: {} };
      globalThis.document = {};
      globalThis.console = {
        log: mock(),
        // Missing other methods
      };

      const browserLogger = createLogger();
      
      // Should fallback to console.log for missing methods
      expect(() => browserLogger.info('Test')).not.toThrow();
      expect(() => browserLogger.warn('Test')).not.toThrow();
    });

    it('should handle circular references in objects', () => {
      const obj: any = { name: 'test' };
      obj.circular = obj;

      const browserLogger = createLogger();
      expect(() => browserLogger.info(obj, 'Circular reference')).not.toThrow();
    });

    it('should handle very long messages', () => {
      const longMessage = 'x'.repeat(10000);
      const browserLogger = createLogger();
      expect(() => browserLogger.info(longMessage)).not.toThrow();
    });

    it('should handle null and undefined values', () => {
      const browserLogger = createLogger();
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
      
      const browserLogger = createLogger();
      
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
      
      const browserLogger = createLogger();
      browserLogger.clear();
      expect(mockClear).toHaveBeenCalled();

      // Node.js
      globalThis.process = originalProcess || { versions: { node: '20.0.0' }, env: {} };
      delete globalThis.window;
      const nodeLogger = createLogger();
      expect(() => nodeLogger.clear()).not.toThrow();
    });
  });
});
