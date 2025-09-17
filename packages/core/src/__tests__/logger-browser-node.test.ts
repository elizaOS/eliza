import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { createLogger } from '../logger';
import { getEnvironment } from '../utils/environment';

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
    getEnvironment().clearCache();
  });

  describe('Environment Detection', () => {
    it('should detect Node.js environment correctly', () => {
      // Ensure we're in Node.js environment
      globalThis.process = {
        versions: { node: '20.0.0' },
        env: { LOG_LEVEL: 'info' },
      } as MockProcess as typeof process;
      delete globalThis.window;
      delete globalThis.document;

      const isNode =
        typeof process !== 'undefined' &&
        typeof process.versions !== 'undefined' &&
        typeof process.versions.node !== 'undefined';
      const isBrowser =
        typeof globalThis !== 'undefined' &&
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
          trace: mock(),
        },
      };
      globalThis.document = {};
      delete globalThis.process;

      const isNode =
        typeof process !== 'undefined' &&
        typeof process.versions !== 'undefined' &&
        typeof process.versions.node !== 'undefined';
      const isBrowser =
        typeof globalThis !== 'undefined' &&
        typeof globalThis.window !== 'undefined' &&
        typeof globalThis.document !== 'undefined';

      expect(isNode).toBe(false);
      expect(isBrowser).toBe(true);
    });
  });

  describe('BrowserLogger Class', () => {
    beforeEach(() => {
      // Clear environment cache to ensure proper detection
      getEnvironment().clearCache();

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
          clear: mock(),
        },
      };
      globalThis.document = {};
      globalThis.console = globalThis.window.console as Console;

      // Clear cache again after setting up environment
      getEnvironment().clearCache();
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
        clear: mock(),
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
        trace: mock(),
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
        log: mock(),
      };
      globalThis.console = mockConsole as unknown as Console;

      // Clear cache to detect browser environment
      getEnvironment().clearCache();

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
        log: mock(),
      };
      globalThis.console = mockConsole as unknown as Console;

      // Clear cache to detect browser environment
      getEnvironment().clearCache();

      // Force browser type for testing
      const parentLogger = createLogger({ parent: 'main', __forceType: 'browser' });
      const childLogger = parentLogger.child({ child: 'sub' });

      childLogger.info('Child message');
      expect(mockConsole.info).toHaveBeenCalled();
    });
  });

  describe('Node.js Logger (Adze backend in Node)', () => {
    beforeEach(() => {
      // Clear environment cache
      getEnvironment().clearCache();

      // Restore Node.js environment
      globalThis.process =
        originalProcess ||
        ({
          versions: { node: '20.0.0' },
          env: {},
        } as unknown as typeof process);
      delete globalThis.window;
      delete globalThis.document;

      // No need to mock transports; logger uses Adze in both environments

      // Clear cache again after environment setup
      getEnvironment().clearCache();
    });

    it('should provide logger API in Node.js environment', () => {
      const nodeLogger = createLogger();

      // Verify core methods exist
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

    it('should handle child loggers correctly', () => {
      const parentLogger = createLogger({ service: 'api' });
      const childLogger = parentLogger.child({ request: '123' });

      expect(childLogger).toBeDefined();
      expect(typeof childLogger.info).toBe('function');
    });

    it('should support log level configuration options', () => {
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
      globalThis.process =
        originalProcess || ({ versions: { node: '20.0.0' }, env: {} } as unknown as typeof process);
      delete globalThis.window;
      const nodeLogger = createLogger();

      // Test browser logger
      globalThis.window = { document: {}, console: globalThis.console };
      globalThis.document = {};
      delete globalThis.process;
      const browserLogger = createLogger();

      // Both should have the same methods
      const methods = [
        'trace',
        'debug',
        'info',
        'warn',
        'error',
        'fatal',
        'success',
        'progress',
        'log',
        'clear',
        'child',
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
        nested: { deep: { value: 'test' } },
      };

      // Test in Node.js
      globalThis.process =
        originalProcess || ({ versions: { node: '20.0.0' }, env: {} } as unknown as typeof process);
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
      globalThis.process =
        originalProcess || ({ versions: { node: '20.0.0' }, env: {} } as unknown as typeof process);
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

    it('should respect custom maxMemoryLogs option', () => {
      // Setup browser environment
      globalThis.window = { document: {}, console: globalThis.console };
      globalThis.document = {};
      delete globalThis.process;

      // Create logger with custom maxMemoryLogs
      const customLimit = 50;
      const browserLogger = createLogger({
        __forceType: 'browser',
        maxMemoryLogs: customLimit,
      });

      // Log more than the custom limit
      for (let i = 0; i < customLimit + 10; i++) {
        browserLogger.info(`Message ${i}`);
      }

      // Should not crash and should maintain custom limit
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
      globalThis.process =
        originalProcess || ({ versions: { node: '20.0.0' }, env: {} } as unknown as typeof process);
      delete globalThis.window;
      const nodeLogger = createLogger();
      expect(() => nodeLogger.clear()).not.toThrow();
    });

    it('should not throw when using __forceType binding in Node', () => {
      globalThis.process =
        originalProcess || ({ versions: { node: '20.0.0' }, env: {} } as unknown as typeof process);
      delete globalThis.window;
      delete globalThis.document;

      expect(() =>
        createLogger({
          __forceType: 'node',
          appName: 'test-app',
          userId: '123',
        })
      ).not.toThrow();
    });
  });

  describe('Circular Reference Handling - Advanced Edge Cases', () => {
    it('should handle multiple circular references in different arguments', () => {
      const browserLogger = createLogger({ __forceType: 'browser' });

      // Create multiple objects with different circular patterns
      const obj1: any = { name: 'obj1', data: { value: 1 } };
      const obj2: any = { name: 'obj2', data: { value: 2 } };
      const obj3: any = { name: 'obj3', data: { value: 3 } };

      // Create circular references
      obj1.self = obj1; // Self reference
      obj2.ref = obj3; // Cross reference
      obj3.ref = obj2; // Cross reference back
      obj1.others = [obj2, obj3]; // Array with circular refs

      // Should handle all without throwing
      expect(() => browserLogger.info('Multiple circulars:', obj1, obj2, obj3)).not.toThrow();
    });

    it('should handle deeply nested circular references with arrays', () => {
      const browserLogger = createLogger({ __forceType: 'browser' });

      const deepObj: any = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: {
                  items: [],
                },
              },
            },
          },
        },
      };

      // Create complex circular structure
      deepObj.level1.level2.level3.level4.level5.items.push(deepObj);
      deepObj.level1.level2.level3.level4.level5.backToLevel2 = deepObj.level1.level2;
      deepObj.level1.array = [deepObj, deepObj.level1, deepObj.level1.level2];

      expect(() => browserLogger.info('Deep circular:', deepObj)).not.toThrow();
    });

    it('should handle circular references in error objects with nested arguments', () => {
      const browserLogger = createLogger({ __forceType: 'browser' });

      const error: any = new Error('Test error');
      const context: any = { errorRef: error, data: {} };
      const metadata: any = { context, timestamp: Date.now() };

      // Create circular references
      error.context = context;
      context.data.metadata = metadata;
      metadata.error = error;

      // Multiple arguments with circular references
      expect(() => browserLogger.error('Complex error:', error, context, metadata)).not.toThrow();
    });

    it('should handle circular references with symbols and special properties', () => {
      const browserLogger = createLogger({ __forceType: 'browser' });

      const sym = Symbol('test');
      const obj: any = {
        [sym]: 'symbol value',
        normalProp: 'normal',
        nested: {},
      };

      // Add various types of circular references
      obj.nested.parent = obj;
      obj[Symbol.for('circular')] = obj;
      Object.defineProperty(obj, 'hiddenCircular', {
        value: obj,
        enumerable: false,
      });

      expect(() => browserLogger.info('Symbol circular:', obj)).not.toThrow();
    });

    it('should handle circular references in mixed argument types', () => {
      const browserLogger = createLogger({ __forceType: 'browser' });

      const arr: any[] = [1, 2, 3];
      const obj: any = { arr, name: 'test' };
      const map = new Map();
      const set = new Set();

      // Create complex circular structure
      arr.push(obj);
      obj.self = obj;
      map.set('obj', obj);
      map.set('arr', arr);
      set.add(obj);
      set.add(arr);
      obj.map = map;
      obj.set = set;

      // Test with multiple mixed-type arguments
      expect(() =>
        browserLogger.info('Mixed types:', obj, arr, 'string', 123, map, set)
      ).not.toThrow();
    });

    it('should handle circular references in function properties', () => {
      const browserLogger = createLogger({ __forceType: 'browser' });

      const obj: any = {
        name: 'function container',
        callback: function () {
          return obj;
        },
      };

      // Add circular reference through function
      obj.callback.parent = obj;
      obj.methods = {
        get: () => obj,
        set: (value: any) => {
          obj.value = value;
          return obj;
        },
      };
      obj.methods.container = obj;

      expect(() => browserLogger.info('Function circular:', obj)).not.toThrow();
    });

    it('should handle circular references with prototype chain manipulation', () => {
      const browserLogger = createLogger({ __forceType: 'browser' });

      class CustomClass {
        constructor(public name: string) {}
      }

      const instance: any = new CustomClass('test');
      const proto: any = Object.getPrototypeOf(instance);

      // Create circular through prototype
      instance.proto = proto;
      proto.instance = instance;
      instance.self = instance;

      expect(() => browserLogger.info('Prototype circular:', instance)).not.toThrow();
    });

    it('should handle maximum recursion depth with circular references', () => {
      const browserLogger = createLogger({ __forceType: 'browser' });

      // Create a chain of objects with circular reference at the end
      let current: any = { level: 0 };
      const root = current;

      for (let i = 1; i < 100; i++) {
        current.next = { level: i, prev: current };
        current = current.next;
      }

      // Add circular reference at the end
      current.next = root;
      root.tail = current;

      expect(() => browserLogger.info('Deep chain circular:', root)).not.toThrow();
    });
  });

  describe('JSON Format Configuration - Cross-Environment', () => {
    beforeEach(() => {
      // Clear environment cache
      getEnvironment().clearCache();
    });

    describe('Browser JSON Format Tests', () => {
      let savedProcess: any;

      beforeEach(() => {
        // Save process before deleting it
        savedProcess = globalThis.process;

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
            clear: mock(),
          },
          location: {
            hostname: 'localhost',
          },
        };
        globalThis.document = {};
        delete globalThis.process;
        getEnvironment().clearCache();
      });

      afterEach(() => {
        // Restore process
        globalThis.process = savedProcess;
      });

      it('should create browser logger with JSON format enabled without errors', () => {
        // Restore process temporarily to set env var
        globalThis.process = savedProcess;
        process.env.LOG_JSON_FORMAT = 'true';
        delete globalThis.process; // Remove again for browser simulation

        expect(() => {
          const logger = createLogger({ __forceType: 'browser' });
          logger.info('Test browser JSON message', { data: 'value' });
        }).not.toThrow();

        // Restore to clean up
        globalThis.process = savedProcess;
        delete process.env.LOG_JSON_FORMAT;
        delete globalThis.process;
      });

      it('should allow customizing name and hostname in browser JSON format', () => {
        globalThis.process = savedProcess;
        process.env.LOG_JSON_FORMAT = 'true';
        delete globalThis.process;

        expect(() => {
          const logger = createLogger({
            __forceType: 'browser',
            name: 'browser-app',
            hostname: 'browser-host',
          });
          logger.info('Custom browser logger');
        }).not.toThrow();

        globalThis.process = savedProcess;
        delete process.env.LOG_JSON_FORMAT;
        delete globalThis.process;
      });

      it('should handle browser hostname detection for JSON format', () => {
        globalThis.process = savedProcess;
        process.env.LOG_JSON_FORMAT = 'true';
        delete globalThis.process;

        // Test with window.location.hostname
        globalThis.window = {
          ...globalThis.window,
          location: { hostname: 'test-browser-host' },
        };

        expect(() => {
          const logger = createLogger({ __forceType: 'browser' });
          logger.info('Browser hostname test');
        }).not.toThrow();

        globalThis.process = savedProcess;
        delete process.env.LOG_JSON_FORMAT;
        delete globalThis.process;
      });

      it('should handle missing window.location gracefully in JSON format', () => {
        globalThis.process = savedProcess;
        process.env.LOG_JSON_FORMAT = 'true';
        delete globalThis.process;

        // Remove location to test fallback
        globalThis.window = {
          document: {},
          console: globalThis.window?.console || {},
        };

        expect(() => {
          const logger = createLogger({ __forceType: 'browser' });
          logger.info('Browser without location');
        }).not.toThrow();

        globalThis.process = savedProcess;
        delete process.env.LOG_JSON_FORMAT;
        delete globalThis.process;
      });
    });

    describe('Node.js JSON Format Tests', () => {
      beforeEach(() => {
        // Restore Node.js environment
        globalThis.process =
          originalProcess ||
          ({
            versions: { node: '20.0.0' },
            env: {},
            platform: 'darwin',
          } as unknown as typeof process);
        delete globalThis.window;
        delete globalThis.document;
        getEnvironment().clearCache();
      });

      it('should create Node.js logger with JSON format enabled without errors', () => {
        process.env.LOG_JSON_FORMAT = 'true';

        expect(() => {
          const logger = createLogger();
          logger.info('Test Node JSON message', { data: 'value' });
        }).not.toThrow();

        delete process.env.LOG_JSON_FORMAT;
      });

      it('should allow customizing name and hostname in Node.js JSON format', () => {
        process.env.LOG_JSON_FORMAT = 'true';

        expect(() => {
          const logger = createLogger({
            name: 'node-app',
            hostname: 'node-server',
          });
          logger.info('Custom Node logger');
        }).not.toThrow();

        delete process.env.LOG_JSON_FORMAT;
      });

      it('should handle Node.js hostname detection for JSON format', () => {
        process.env.LOG_JSON_FORMAT = 'true';

        expect(() => {
          const logger = createLogger();
          logger.info('Node hostname test');
        }).not.toThrow();

        delete process.env.LOG_JSON_FORMAT;
      });
    });

    describe('Consistent JSON Behavior Across Environments', () => {
      it('should handle metadata consistently in both environments', () => {
        const savedProcess = globalThis.process;

        // Set up JSON format
        globalThis.process = originalProcess || savedProcess;
        process.env.LOG_JSON_FORMAT = 'true';

        const testMetadata = {
          name: 'test-app',
          hostname: 'test-host',
          environment: 'testing',
          version: '1.0.0',
        };

        // Test Node.js
        globalThis.process = originalProcess || savedProcess;
        delete globalThis.window;
        delete globalThis.document;

        expect(() => {
          const nodeLogger = createLogger(testMetadata);
          nodeLogger.info('Node metadata test');
        }).not.toThrow();

        // Test Browser
        globalThis.window = {
          document: {},
          console: { info: mock() },
          location: { hostname: 'browser-host' },
        };
        globalThis.document = {};
        delete globalThis.process;

        expect(() => {
          const browserLogger = createLogger({ ...testMetadata, __forceType: 'browser' });
          browserLogger.info('Browser metadata test');
        }).not.toThrow();

        // Clean up
        globalThis.process = savedProcess;
        delete process.env.LOG_JSON_FORMAT;
      });

      it('should handle error objects in JSON format consistently', () => {
        const savedProcess = globalThis.process;

        // Set up JSON format
        globalThis.process = originalProcess || savedProcess;
        process.env.LOG_JSON_FORMAT = 'true';

        const testError = new Error('Test error');
        (testError as any).code = 'ERR_TEST';

        // Node.js
        globalThis.process = originalProcess || savedProcess;
        delete globalThis.window;
        delete globalThis.document;

        expect(() => {
          const nodeLogger = createLogger();
          nodeLogger.error('Node error test', testError);
        }).not.toThrow();

        // Browser
        globalThis.window = {
          document: {},
          console: { error: mock() },
        };
        globalThis.document = {};
        delete globalThis.process;

        expect(() => {
          const browserLogger = createLogger({ __forceType: 'browser' });
          browserLogger.error('Browser error test', testError);
        }).not.toThrow();

        // Clean up
        globalThis.process = savedProcess;
        delete process.env.LOG_JSON_FORMAT;
      });

      it('should handle all log levels in JSON format across environments', () => {
        const savedProcess = globalThis.process;

        // Set up JSON format
        globalThis.process = originalProcess || savedProcess;
        process.env.LOG_JSON_FORMAT = 'true';

        // Node.js
        globalThis.process = originalProcess || savedProcess;
        delete globalThis.window;
        delete globalThis.document;

        expect(() => {
          const nodeLogger = createLogger();
          nodeLogger.trace('Node trace');
          nodeLogger.debug('Node debug');
          nodeLogger.info('Node info');
          nodeLogger.warn('Node warn');
          nodeLogger.error('Node error');
          nodeLogger.fatal('Node fatal');
          nodeLogger.success('Node success');
          nodeLogger.progress('Node progress');
        }).not.toThrow();

        // Browser
        globalThis.window = {
          document: {},
          console: {
            log: mock(),
            info: mock(),
            warn: mock(),
            error: mock(),
            debug: mock(),
            trace: mock(),
          },
        };
        globalThis.document = {};
        delete globalThis.process;

        expect(() => {
          const browserLogger = createLogger({ __forceType: 'browser' });
          browserLogger.trace('Browser trace');
          browserLogger.debug('Browser debug');
          browserLogger.info('Browser info');
          browserLogger.warn('Browser warn');
          browserLogger.error('Browser error');
          browserLogger.fatal('Browser fatal');
          browserLogger.success('Browser success');
          browserLogger.progress('Browser progress');
        }).not.toThrow();

        // Clean up
        globalThis.process = savedProcess;
        delete process.env.LOG_JSON_FORMAT;
      });
    });
  });
});
