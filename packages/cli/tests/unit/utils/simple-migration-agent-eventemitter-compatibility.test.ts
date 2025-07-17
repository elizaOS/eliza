/**
 * Unit tests for EventEmitter compatibility of SimpleMigrationAgent
 * Tests that the EventTarget-based agent maintains EventEmitter-like API
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SimpleMigrationAgent } from '../../../src/utils/upgrade/simple-migration-agent';
import * as path from 'path';

// Mock dependencies
mock.module('@anthropic-ai/claude-code', () => ({
  query: () => {
    return (async function* () {
      yield { type: 'system', subtype: 'init' };
      yield { type: 'result', subtype: 'success' };
    })();
  },
}));

mock.module('../../../src/utils/upgrade/migration-guide-loader', () => ({
  createMigrationGuideLoader: () => ({
    getAllGuidesContent: () => 'Mock guide content',
    generateMigrationContext: () => 'Mock context',
    getGuidesByCategory: () => [],
    getRelevantGuidesForIssue: () => [],
    searchGuides: () => [],
  }),
  MigrationGuideLoader: class {},
}));

mock.module('@elizaos/core', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  },
}));

describe('SimpleMigrationAgent EventEmitter Compatibility', () => {
  let agent: SimpleMigrationAgent;
  const testPath = '/test/repo/path';

  beforeEach(() => {
    agent = new SimpleMigrationAgent(testPath);
  });

  describe('on() method', () => {
    it('should add event listeners', (done) => {
      agent.on('test-event', (data) => {
        expect(data).toEqual({ message: 'test' });
        done();
      });

      // Manually emit event using EventTarget API
      agent.dispatchEvent(new CustomEvent('test-event', { detail: { message: 'test' } }));
    });

    it('should support multiple listeners for same event', () => {
      let count = 0;
      const handler1 = () => {
        count++;
      };
      const handler2 = () => {
        count++;
      };

      agent.on('multi-listener', handler1);
      agent.on('multi-listener', handler2);

      // Manually emit event
      agent.dispatchEvent(new CustomEvent('multi-listener', { detail: {} }));

      expect(count).toBe(2);
    });

    it('should not add duplicate handlers', () => {
      let count = 0;
      const handler = () => {
        count++;
      };

      agent.on('duplicate-test', handler);
      agent.on('duplicate-test', handler); // Try to add same handler again

      // Manually emit event
      agent.dispatchEvent(new CustomEvent('duplicate-test', { detail: {} }));

      expect(count).toBe(1); // Should only be called once
    });

    it('should return this for method chaining', () => {
      const handler = () => {};
      const result = agent.on('chain-test', handler);
      expect(result).toBe(agent);
    });

    it('should handle undefined data', (done) => {
      agent.on('undefined-event', (data) => {
        // Note: CustomEvent detail converts undefined to null
        expect(data).toBeNull();
        done();
      });

      agent.dispatchEvent(new CustomEvent('undefined-event', { detail: undefined }));
    });

    it('should pass data correctly to handlers', (done) => {
      const testData = { foo: 'bar', num: 123, nested: { value: true } };

      agent.on('data-test', (data) => {
        expect(data).toEqual(testData);
        expect(data.foo).toBe('bar');
        expect(data.num).toBe(123);
        expect(data.nested.value).toBe(true);
        done();
      });

      agent.dispatchEvent(new CustomEvent('data-test', { detail: testData }));
    });
  });

  describe('off() method', () => {
    it('should remove event listeners', () => {
      let called = false;
      const handler = () => {
        called = true;
      };

      agent.on('test-off', handler);
      agent.off('test-off', handler);

      agent.dispatchEvent(new CustomEvent('test-off', { detail: {} }));

      expect(called).toBe(false);
    });

    it('should only remove specified handler', () => {
      let called1 = false;
      let called2 = false;
      const handler1 = () => {
        called1 = true;
      };
      const handler2 = () => {
        called2 = true;
      };

      agent.on('selective-off', handler1);
      agent.on('selective-off', handler2);
      agent.off('selective-off', handler1);

      agent.dispatchEvent(new CustomEvent('selective-off', { detail: {} }));

      expect(called1).toBe(false);
      expect(called2).toBe(true);
    });

    it('should handle removing non-existent handler gracefully', () => {
      const handler = () => {};
      // Should not throw
      expect(() => {
        agent.off('non-existent', handler);
      }).not.toThrow();
    });

    it('should clean up internal maps when last handler is removed', () => {
      const handler = () => {};

      agent.on('cleanup-test', handler);
      agent.off('cleanup-test', handler);

      // The internal handlers map should no longer have this event
      // We can test this by checking if adding the same handler again works
      let count = 0;
      const newHandler = () => {
        count++;
      };

      agent.on('cleanup-test', newHandler);
      agent.on('cleanup-test', newHandler); // This should not add duplicate

      agent.dispatchEvent(new CustomEvent('cleanup-test', { detail: {} }));

      expect(count).toBe(1);
    });
  });

  describe('removeListener() method', () => {
    it('should be an alias for off()', () => {
      let called = false;
      const handler = () => {
        called = true;
      };

      agent.on('test-removeListener', handler);
      agent.removeListener('test-removeListener', handler);

      agent.dispatchEvent(new CustomEvent('test-removeListener', { detail: {} }));

      expect(called).toBe(false);
    });
  });

  describe('removeAllListeners() method', () => {
    it('should remove all listeners for a specific event', () => {
      let called1 = false;
      let called2 = false;
      let called3 = false;

      agent.on('remove-all-specific', () => {
        called1 = true;
      });
      agent.on('remove-all-specific', () => {
        called2 = true;
      });
      agent.on('other-event', () => {
        called3 = true;
      });

      agent.removeAllListeners('remove-all-specific');

      agent.dispatchEvent(new CustomEvent('remove-all-specific', { detail: {} }));
      agent.dispatchEvent(new CustomEvent('other-event', { detail: {} }));

      expect(called1).toBe(false);
      expect(called2).toBe(false);
      expect(called3).toBe(true); // Other event should still work
    });

    it('should remove all listeners when no event specified', () => {
      let called1 = false;
      let called2 = false;
      let called3 = false;

      agent.on('event1', () => {
        called1 = true;
      });
      agent.on('event2', () => {
        called2 = true;
      });
      agent.on('event3', () => {
        called3 = true;
      });

      agent.removeAllListeners();

      agent.dispatchEvent(new CustomEvent('event1', { detail: {} }));
      agent.dispatchEvent(new CustomEvent('event2', { detail: {} }));
      agent.dispatchEvent(new CustomEvent('event3', { detail: {} }));

      expect(called1).toBe(false);
      expect(called2).toBe(false);
      expect(called3).toBe(false);
    });
  });

  describe('listenerCount() method', () => {
    it('should return the number of listeners for an event', () => {
      expect(agent.listenerCount('count-test')).toBe(0);

      agent.on('count-test', () => {});
      expect(agent.listenerCount('count-test')).toBe(1);

      agent.on('count-test', () => {});
      expect(agent.listenerCount('count-test')).toBe(2);

      const handler = () => {};
      agent.on('count-test', handler);
      expect(agent.listenerCount('count-test')).toBe(3);

      agent.off('count-test', handler);
      expect(agent.listenerCount('count-test')).toBe(2);
    });

    it('should return 0 for non-existent events', () => {
      expect(agent.listenerCount('non-existent')).toBe(0);
    });
  });

  describe('listeners() method', () => {
    it('should return an array of listeners for an event', () => {
      const handler1 = () => {};
      const handler2 = () => {};
      const handler3 = () => {};

      agent.on('listeners-test', handler1);
      agent.on('listeners-test', handler2);
      agent.on('listeners-test', handler3);

      const listeners = agent.listeners('listeners-test');
      expect(listeners).toBeArray();
      expect(listeners.length).toBe(3);
      expect(listeners).toContain(handler1);
      expect(listeners).toContain(handler2);
      expect(listeners).toContain(handler3);
    });

    it('should return empty array for non-existent events', () => {
      const listeners = agent.listeners('non-existent');
      expect(listeners).toBeArray();
      expect(listeners.length).toBe(0);
    });
  });

  describe('EventEmitter-like behavior', () => {
    it('should execute listeners in order of registration', () => {
      const order: number[] = [];

      agent.on('order-test', () => order.push(1));
      agent.on('order-test', () => order.push(2));
      agent.on('order-test', () => order.push(3));

      agent.dispatchEvent(new CustomEvent('order-test', { detail: {} }));

      expect(order).toEqual([1, 2, 3]);
    });

    it('should handle complex data types', (done) => {
      const complexData = {
        array: [1, 2, 3],
        nested: {
          deep: {
            value: 'test',
          },
        },
        date: new Date(),
        nullValue: null,
        undefinedValue: undefined,
        buffer: Buffer.from('test'),
      };

      agent.on('complex-data', (data) => {
        expect(data).toEqual(complexData);
        expect(data.array).toEqual([1, 2, 3]);
        expect(data.nested.deep.value).toBe('test');
        expect(data.buffer.toString()).toBe('test');
        done();
      });

      agent.dispatchEvent(new CustomEvent('complex-data', { detail: complexData }));
    });

    it('should handle events during migration lifecycle', (done) => {
      const events: string[] = [];

      agent.on('start', () => events.push('start'));
      agent.on('progress', (count) => {
        events.push(`progress-${count}`);
        if (events.length === 2) {
          expect(events).toEqual(['start', 'progress-10']);
          done();
        }
      });

      // Simulate migration lifecycle events
      agent.dispatchEvent(new CustomEvent('start'));
      agent.dispatchEvent(new CustomEvent('progress', { detail: 10 }));
    });
  });

  describe('Memory and performance', () => {
    it('should handle many listeners without issues', () => {
      const handlers: (() => void)[] = [];
      let totalCalls = 0;

      // Add 100 listeners
      for (let i = 0; i < 100; i++) {
        const handler = () => {
          totalCalls++;
        };
        handlers.push(handler);
        agent.on('many-listeners', handler);
      }

      agent.dispatchEvent(new CustomEvent('many-listeners', { detail: {} }));
      expect(totalCalls).toBe(100);

      // Clean up
      handlers.forEach((handler) => {
        agent.off('many-listeners', handler);
      });

      expect(agent.listenerCount('many-listeners')).toBe(0);
    });

    it('should handle rapid fire events', () => {
      let count = 0;
      agent.on('rapid-fire', () => {
        count++;
      });

      for (let i = 0; i < 1000; i++) {
        agent.dispatchEvent(new CustomEvent('rapid-fire', { detail: { index: i } }));
      }

      expect(count).toBe(1000);
    });

    it('should properly clean up memory when listeners are removed', () => {
      const handlers: (() => void)[] = [];

      // Add and remove many listeners
      for (let i = 0; i < 100; i++) {
        const handler = () => {};
        handlers.push(handler);
        agent.on(`event-${i}`, handler);
      }

      // Remove all listeners
      for (let i = 0; i < 100; i++) {
        agent.off(`event-${i}`, handlers[i]);
      }

      // Verify all events have 0 listeners
      for (let i = 0; i < 100; i++) {
        expect(agent.listenerCount(`event-${i}`)).toBe(0);
      }
    });
  });

  describe('Integration with SimpleMigrationAgent', () => {
    it('should maintain compatibility during abort()', () => {
      let abortedCalled = false;

      agent.on('aborted', () => {
        abortedCalled = true;
      });

      // Note: We can't fully test abort() without mocking more internals,
      // but we can verify the event listener is properly registered
      expect(agent.listenerCount('aborted')).toBe(1);
    });

    it('should allow listening to migration events', () => {
      const eventTypes = ['start', 'progress', 'complete', 'error', 'aborted'];

      eventTypes.forEach((eventType) => {
        agent.on(eventType, () => {});
      });

      // Verify all event listeners were added
      eventTypes.forEach((eventType) => {
        expect(agent.listenerCount(eventType)).toBe(1);
      });

      // Clean up
      agent.removeAllListeners();

      // Verify all were removed
      eventTypes.forEach((eventType) => {
        expect(agent.listenerCount(eventType)).toBe(0);
      });
    });
  });
});
