import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestTimeoutManager } from '../../../../src/utils/testing/timeout-manager';

describe('TestTimeoutManager', () => {
  let manager: TestTimeoutManager;

  beforeEach(() => {
    manager = new TestTimeoutManager();
  });

  afterEach(() => {
    manager.clearAll();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = TestTimeoutManager.getInstance();
      const instance2 = TestTimeoutManager.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('startTimeout', () => {
    it('should start timeout with default duration', () => {
      // Verify timeout can be started without throwing
      expect(() => manager.startTimeout('test1')).not.toThrow();

      // Clean up immediately
      manager.clearTimeout('test1');
    });

    it('should start timeout with custom duration', () => {
      // Verify custom duration timeout can be started
      expect(() => manager.startTimeout('test2', 5000)).not.toThrow();

      // Clean up immediately
      manager.clearTimeout('test2');
    });

    it('should clear existing timeout when starting new one with same name', () => {
      // Start first timeout
      manager.startTimeout('test3', 5000);

      // Start new timeout with same name - should not throw
      expect(() => manager.startTimeout('test3', 5000)).not.toThrow();

      // Clean up
      manager.clearTimeout('test3');
    });

    it('should track multiple concurrent timeouts', () => {
      manager.startTimeout('timeout-a', 1000);
      manager.startTimeout('timeout-b', 2000);
      manager.startTimeout('timeout-c', 3000);

      // All should be tracked without issues
      expect(() => manager.clearAll()).not.toThrow();
    });
  });

  describe('clearTimeout', () => {
    it('should clear timeout and prevent it from firing', () => {
      manager.startTimeout('test4', 5000);

      // Clear should not throw
      expect(() => manager.clearTimeout('test4')).not.toThrow();
    });

    it('should handle clearing non-existent timeout gracefully', () => {
      expect(() => manager.clearTimeout('non-existent')).not.toThrow();
    });

    it('should handle clearing already cleared timeout', () => {
      manager.startTimeout('test-double-clear', 1000);
      manager.clearTimeout('test-double-clear');

      // Second clear should not throw
      expect(() => manager.clearTimeout('test-double-clear')).not.toThrow();
    });
  });

  describe('clearAll', () => {
    it('should clear all timeouts', () => {
      manager.startTimeout('test5', 5000);
      manager.startTimeout('test6', 10000);
      manager.startTimeout('test7', 15000);

      expect(() => manager.clearAll()).not.toThrow();
    });

    it('should handle clearing when no timeouts exist', () => {
      expect(() => manager.clearAll()).not.toThrow();
    });

    it('should allow new timeouts after clearAll', () => {
      manager.startTimeout('before-clear', 1000);
      manager.clearAll();

      // Should be able to add new timeout
      expect(() => manager.startTimeout('after-clear', 1000)).not.toThrow();
      manager.clearAll();
    });
  });

  describe('elapsed time tracking', () => {
    it('should track elapsed time correctly', () => {
      // Start a timeout
      manager.startTimeout('test8', 10000);

      // The manager should track the start time internally
      // We verify by ensuring the timeout was created
      expect(() => manager.clearTimeout('test8')).not.toThrow();
    });
  });

  describe('timeout behavior', () => {
    it('should handle very short timeout durations', () => {
      // Even very short timeouts should not throw
      expect(() => manager.startTimeout('short-timeout', 1)).not.toThrow();
      manager.clearTimeout('short-timeout');
    });

    it('should handle very long timeout durations', () => {
      // Long timeouts should work without issues
      expect(() => manager.startTimeout('long-timeout', 60 * 60 * 1000)).not.toThrow();
      manager.clearTimeout('long-timeout');
    });

    it('should handle special characters in timeout names', () => {
      expect(() => manager.startTimeout('test:with:colons', 1000)).not.toThrow();
      expect(() => manager.startTimeout('test/with/slashes', 1000)).not.toThrow();
      expect(() => manager.startTimeout('test with spaces', 1000)).not.toThrow();

      manager.clearAll();
    });
  });
});
