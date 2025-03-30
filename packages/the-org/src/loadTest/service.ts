import { Service, IAgentRuntime, UUID } from '@elizaos/core';

export class LoadTestService extends Service {
  static serviceType = 'load-test';
  capabilityDescription = 'Provides load testing capabilities for agent scaling tests';

  private activeTests: Map<
    string,
    {
      startTime: number;
      messageCount: number;
      errors: number;
    }
  > = new Map();

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  async stop(): Promise<void> {
    this.activeTests.clear();
  }

  startTest(testId: string) {
    this.activeTests.set(testId, {
      startTime: Date.now(),
      messageCount: 0,
      errors: 0,
    });
  }

  recordMessage(testId: string) {
    const test = this.activeTests.get(testId);
    if (test) {
      test.messageCount++;
    }
  }

  recordError(testId: string) {
    const test = this.activeTests.get(testId);
    if (test) {
      test.errors++;
    }
  }

  getTestMetrics(testId: string) {
    return this.activeTests.get(testId);
  }

  endTest(testId: string) {
    this.activeTests.delete(testId);
  }
}
