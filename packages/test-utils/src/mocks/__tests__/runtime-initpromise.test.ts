/**
 * @fileoverview Tests for mock runtime initPromise behavior
 *
 * These tests verify that the mock runtime's initPromise correctly mimics
 * the actual AgentRuntime's initialization behavior, preventing timing bugs.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { createMockRuntime } from '../runtime';
import type { IAgentRuntime } from '@elizaos/core';

describe('Mock Runtime initPromise', () => {
  describe('Default Behavior', () => {
    it('should create a pending promise by default', () => {
      const runtime = createMockRuntime();

      // The promise should be pending, not resolved
      let resolved = false;
      runtime.initPromise.then(() => {
        resolved = true;
      });

      // Give it a tick to resolve if it was going to
      setTimeout(() => {
        expect(resolved).toBe(false);
      }, 10);
    });

    it('should resolve initPromise when resolveInit is called', async () => {
      const runtime = createMockRuntime();
      let resolved = false;

      const checkPromise = runtime.initPromise.then(() => {
        resolved = true;
      });

      // Should not be resolved yet
      expect(resolved).toBe(false);

      // Simulate initialization completion
      (runtime as any).resolveInit();

      // Wait for promise to resolve
      await checkPromise;

      // Should now be resolved
      expect(resolved).toBe(true);
    });

    it('should reject initPromise when rejectInit is called', async () => {
      const runtime = createMockRuntime();
      const testError = new Error('Initialization failed');

      const checkPromise = runtime.initPromise
        .then(() => {
          throw new Error('Promise should have rejected');
        })
        .catch((error) => {
          expect(error).toBe(testError);
        });

      // Simulate initialization failure
      (runtime as any).rejectInit(testError);

      // Wait for promise to reject
      await checkPromise;
    });

    it('should automatically resolve initPromise when initialize() is called', async () => {
      const runtime = createMockRuntime();
      let resolved = false;

      const checkPromise = runtime.initPromise.then(() => {
        resolved = true;
      });

      // Should not be resolved yet
      expect(resolved).toBe(false);

      // Call initialize (matching actual usage)
      await runtime.initialize();

      // Wait for promise to resolve
      await checkPromise;

      // Should now be resolved
      expect(resolved).toBe(true);
    });
  });

  describe('Override Behavior', () => {
    it('should allow overriding initPromise with a pre-resolved promise', async () => {
      const runtime = createMockRuntime({
        initPromise: Promise.resolve(),
      });

      let resolved = false;
      await runtime.initPromise.then(() => {
        resolved = true;
      });

      // Should be resolved immediately
      expect(resolved).toBe(true);
    });

    it('should allow overriding initPromise with a custom promise', async () => {
      let customResolve: (() => void) | undefined;
      const customPromise = new Promise<void>((resolve) => {
        customResolve = resolve;
      });

      const runtime = createMockRuntime({
        initPromise: customPromise,
      });

      let resolved = false;
      const checkPromise = runtime.initPromise.then(() => {
        resolved = true;
      });

      // Should not be resolved yet
      expect(resolved).toBe(false);

      // Resolve the custom promise
      customResolve!();

      await checkPromise;

      // Should now be resolved
      expect(resolved).toBe(true);
    });
  });

  describe('Multiple Waiters', () => {
    it('should resolve all waiters when resolveInit is called', async () => {
      const runtime = createMockRuntime();
      let waiter1Resolved = false;
      let waiter2Resolved = false;
      let waiter3Resolved = false;

      const promise1 = runtime.initPromise.then(() => {
        waiter1Resolved = true;
      });
      const promise2 = runtime.initPromise.then(() => {
        waiter2Resolved = true;
      });
      const promise3 = runtime.initPromise.then(() => {
        waiter3Resolved = true;
      });

      // None should be resolved yet
      expect(waiter1Resolved).toBe(false);
      expect(waiter2Resolved).toBe(false);
      expect(waiter3Resolved).toBe(false);

      // Resolve initialization
      (runtime as any).resolveInit();

      // Wait for all promises
      await Promise.all([promise1, promise2, promise3]);

      // All should be resolved
      expect(waiter1Resolved).toBe(true);
      expect(waiter2Resolved).toBe(true);
      expect(waiter3Resolved).toBe(true);
    });
  });

  describe('Realistic Usage Pattern', () => {
    it('should mimic actual runtime initialization flow', async () => {
      const runtime = createMockRuntime();
      const events: string[] = [];

      // Simulate code that waits for initialization
      const serviceInit = runtime.initPromise.then(() => {
        events.push('service-started');
      });

      events.push('runtime-created');

      // Simulate some setup
      events.push('pre-init');

      // Initialize runtime
      await runtime.initialize();

      events.push('post-init');

      // Wait for services to start
      await serviceInit;

      // Verify order of events
      // Note: service-started fires before post-init because the promise
      // handlers run synchronously when the promise is resolved
      expect(events).toEqual([
        'runtime-created',
        'pre-init',
        'service-started',
        'post-init',
      ]);
    });

    it('should prevent services from starting before initialization', async () => {
      const runtime = createMockRuntime();
      let serviceStarted = false;

      // Service waits for init
      const serviceInit = runtime.initPromise.then(() => {
        serviceStarted = true;
      });

      // Service should not have started yet
      expect(serviceStarted).toBe(false);

      // Do some work before initialization
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Service still should not have started
      expect(serviceStarted).toBe(false);

      // Initialize runtime
      await runtime.initialize();
      await serviceInit;

      // Now service should have started
      expect(serviceStarted).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should prevent services from starting if initialization fails', async () => {
      const runtime = createMockRuntime();
      let serviceStarted = false;
      let serviceErrorHandled = false;
      const initError = new Error('Init failed');

      // Service waits for init
      const serviceInit = runtime.initPromise
        .then(() => {
          serviceStarted = true;
        })
        .catch((error) => {
          expect(error).toBe(initError);
          serviceErrorHandled = true;
        });

      // Reject initialization
      (runtime as any).rejectInit(initError);

      await serviceInit;

      // Service should not have started
      expect(serviceStarted).toBe(false);
      expect(serviceErrorHandled).toBe(true);
    });
  });
});

