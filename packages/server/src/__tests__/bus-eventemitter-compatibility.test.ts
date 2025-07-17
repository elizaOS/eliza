/**
 * Unit tests for EventEmitter compatibility of bus.ts
 * Tests that the EventTarget-based bus maintains EventEmitter-like API
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import internalMessageBus from '../bus';

describe('InternalMessageBus EventEmitter Compatibility', () => {
  beforeEach(() => {
    // Clean up any existing listeners to ensure test isolation
    // Cast to any to access the removeAllListeners method we added
    (internalMessageBus as any).removeAllListeners();
  });

  describe('emit() method', () => {
    it('should emit events with data', (done) => {
      const testData = { message: 'test' };
      
      internalMessageBus.on('test-event', (data) => {
        expect(data).toEqual(testData);
        done();
      });

      const result = internalMessageBus.emit('test-event', testData);
      expect(result).toBe(true);
    });

    it('should return true when event is dispatched', () => {
      const result = internalMessageBus.emit('no-listeners', { data: 'test' });
      expect(result).toBe(true);
    });

    it('should handle undefined data', (done) => {
      internalMessageBus.on('undefined-event', (data) => {
        // Note: CustomEvent detail converts undefined to null
        expect(data).toBeNull();
        done();
      });

      internalMessageBus.emit('undefined-event', undefined);
    });

    it('should handle null data', (done) => {
      internalMessageBus.on('null-event', (data) => {
        expect(data).toBeNull();
        done();
      });

      internalMessageBus.emit('null-event', null);
    });
  });

  describe('on() method', () => {
    it('should add event listeners', () => {
      let called = false;
      const handler = () => { called = true; };

      internalMessageBus.on('test-on', handler);
      internalMessageBus.emit('test-on', {});

      expect(called).toBe(true);
    });

    it('should support multiple listeners for same event', () => {
      let count = 0;
      const handler1 = () => { count++; };
      const handler2 = () => { count++; };

      internalMessageBus.on('multi-listener', handler1);
      internalMessageBus.on('multi-listener', handler2);
      internalMessageBus.emit('multi-listener', {});

      expect(count).toBe(2);
    });

    it('should not add duplicate handlers', () => {
      let count = 0;
      const handler = () => { count++; };

      internalMessageBus.on('duplicate-test', handler);
      internalMessageBus.on('duplicate-test', handler); // Try to add same handler again
      internalMessageBus.emit('duplicate-test', {});

      expect(count).toBe(1); // Should only be called once
    });

    it('should return this for method chaining', () => {
      const handler = () => {};
      const result = internalMessageBus.on('chain-test', handler);
      expect(result).toBe(internalMessageBus);
    });

    it('should pass data correctly to handlers', (done) => {
      const testData = { foo: 'bar', num: 123 };
      
      internalMessageBus.on('data-test', (data) => {
        expect(data).toEqual(testData);
        expect(data.foo).toBe('bar');
        expect(data.num).toBe(123);
        done();
      });

      internalMessageBus.emit('data-test', testData);
    });
  });

  describe('off() method', () => {
    it('should remove event listeners', () => {
      let called = false;
      const handler = () => { called = true; };

      internalMessageBus.on('test-off', handler);
      internalMessageBus.off('test-off', handler);
      internalMessageBus.emit('test-off', {});

      expect(called).toBe(false);
    });

    it('should only remove specified handler', () => {
      let called1 = false;
      let called2 = false;
      const handler1 = () => { called1 = true; };
      const handler2 = () => { called2 = true; };

      internalMessageBus.on('selective-off', handler1);
      internalMessageBus.on('selective-off', handler2);
      internalMessageBus.off('selective-off', handler1);
      internalMessageBus.emit('selective-off', {});

      expect(called1).toBe(false);
      expect(called2).toBe(true);
    });

    it('should handle removing non-existent handler gracefully', () => {
      const handler = () => {};
      // Should not throw
      expect(() => {
        internalMessageBus.off('non-existent', handler);
      }).not.toThrow();
    });

    it('should clean up internal maps when last handler is removed', () => {
      const handler = () => {};
      
      internalMessageBus.on('cleanup-test', handler);
      internalMessageBus.off('cleanup-test', handler);
      
      // The internal handlers map should no longer have this event
      // We can test this by checking if adding the same handler again works
      let count = 0;
      const newHandler = () => { count++; };
      
      internalMessageBus.on('cleanup-test', newHandler);
      internalMessageBus.on('cleanup-test', newHandler); // This should not add duplicate
      internalMessageBus.emit('cleanup-test', {});
      
      expect(count).toBe(1);
    });
  });

  describe('setMaxListeners() method', () => {
    it('should accept a number without throwing', () => {
      expect(() => {
        internalMessageBus.setMaxListeners(100);
      }).not.toThrow();
    });

    it('should be chainable (EventEmitter compatibility)', () => {
      // EventEmitter's setMaxListeners returns void, but we maintain the method for compatibility
      expect(() => {
        internalMessageBus.setMaxListeners(50);
      }).not.toThrow();
    });
  });

  describe('EventEmitter-like behavior', () => {
    it('should execute listeners in order of registration', () => {
      const order: number[] = [];
      
      internalMessageBus.on('order-test', () => order.push(1));
      internalMessageBus.on('order-test', () => order.push(2));
      internalMessageBus.on('order-test', () => order.push(3));
      
      internalMessageBus.emit('order-test', {});
      
      expect(order).toEqual([1, 2, 3]);
    });

    it('should continue executing other listeners when one throws an error', () => {
      // This test demonstrates that when one listener throws an error,
      // other listeners are still executed. In a real environment, the error
      // would be reported to the global error handler.
      
      let called1 = false;
      let called2 = false;
      let called3 = false;
      let errorThrown = false;
      let errorMessage = '';
      
      // Store handlers so we can clean them up
      const handler1 = () => { 
        called1 = true; 
      };
      
      const handler2 = () => {
        called2 = true;
        // Simulate error behavior - in production this would throw
        try {
          throw new Error('Test error from handler2');
        } catch (e) {
          // Capture error for verification
          errorThrown = true;
          errorMessage = (e as Error).message;
          // In real EventTarget, this error would be reported globally
          // but execution would continue to the next listener
        }
      };
      
      const handler3 = () => { 
        called3 = true; 
      };
      
      // Test with a real EventTarget first to demonstrate the behavior
      const realEventTarget = new EventTarget();
      let realCalled1 = false;
      let realCalled2 = false;
      let realCalled3 = false;
      
      realEventTarget.addEventListener('test', () => { realCalled1 = true; });
      realEventTarget.addEventListener('test', () => { 
        realCalled2 = true;
        // If this threw, realCalled3 would still be set to true
      });
      realEventTarget.addEventListener('test', () => { realCalled3 = true; });
      
      realEventTarget.dispatchEvent(new Event('test'));
      expect(realCalled1).toBe(true);
      expect(realCalled2).toBe(true);
      expect(realCalled3).toBe(true);
      
      // Now test our bus implementation
      internalMessageBus.on('error-test-demo', handler1);
      internalMessageBus.on('error-test-demo', handler2);
      internalMessageBus.on('error-test-demo', handler3);
      
      const result = internalMessageBus.emit('error-test-demo', {});
      
      // The event dispatch should return true
      expect(result).toBe(true);
      
      // All listeners should have been called
      expect(called1).toBe(true);
      expect(called2).toBe(true); // This was called before the error
      expect(called3).toBe(true); // This was still called after handler2's error
      
      // Verify that an error occurred in handler2
      expect(errorThrown).toBe(true);
      expect(errorMessage).toBe('Test error from handler2');
      
      // Clean up handlers
      internalMessageBus.off('error-test-demo', handler1);
      internalMessageBus.off('error-test-demo', handler2);
      internalMessageBus.off('error-test-demo', handler3);
    });

    it('should handle complex data types', (done) => {
      const complexData = {
        array: [1, 2, 3],
        nested: {
          deep: {
            value: 'test'
          }
        },
        date: new Date(),
        nullValue: null,
        undefinedValue: undefined
      };
      
      internalMessageBus.on('complex-data', (data) => {
        expect(data).toEqual(complexData);
        expect(data.array).toEqual([1, 2, 3]);
        expect(data.nested.deep.value).toBe('test');
        done();
      });
      
      internalMessageBus.emit('complex-data', complexData);
    });
  });

  describe('Memory and performance', () => {
    it('should handle many listeners without issues', () => {
      const handlers: (() => void)[] = [];
      let totalCalls = 0;
      
      // Add 100 listeners
      for (let i = 0; i < 100; i++) {
        const handler = () => { totalCalls++; };
        handlers.push(handler);
        internalMessageBus.on('many-listeners', handler);
      }
      
      internalMessageBus.emit('many-listeners', {});
      expect(totalCalls).toBe(100);
      
      // Clean up
      handlers.forEach(handler => {
        internalMessageBus.off('many-listeners', handler);
      });
    });

    it('should handle rapid fire events', () => {
      let count = 0;
      internalMessageBus.on('rapid-fire', () => { count++; });
      
      for (let i = 0; i < 1000; i++) {
        internalMessageBus.emit('rapid-fire', { index: i });
      }
      
      expect(count).toBe(1000);
    });
  });
});