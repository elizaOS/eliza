import { logger } from '@elizaos/core';

export class TestTimeoutManager {
  private static instance: TestTimeoutManager;
  private timeouts: Map<string, NodeJS.Timeout> = new Map();
  private testStartTimes: Map<string, number> = new Map();

  static getInstance(): TestTimeoutManager {
    if (!TestTimeoutManager.instance) {
      TestTimeoutManager.instance = new TestTimeoutManager();
    }
    return TestTimeoutManager.instance;
  }

  startTimeout(testName: string, duration: number = 30000): void {
    this.clearTimeout(testName);
    this.testStartTimes.set(testName, Date.now());

    const timeout = setTimeout(() => {
      const elapsed = Date.now() - (this.testStartTimes.get(testName) || 0);
      logger.error(`Test "${testName}" exceeded timeout of ${duration}ms (elapsed: ${elapsed}ms)`);
      process.exit(1);
    }, duration);

    this.timeouts.set(testName, timeout);
  }

  clearTimeout(testName: string): void {
    const timeout = this.timeouts.get(testName);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(testName);
    }
    this.testStartTimes.delete(testName);
  }

  clearAll(): void {
    this.timeouts.forEach((timeout) => clearTimeout(timeout));
    this.timeouts.clear();
    this.testStartTimes.clear();
  }
}

// Export singleton
export const testTimeout = TestTimeoutManager.getInstance();
