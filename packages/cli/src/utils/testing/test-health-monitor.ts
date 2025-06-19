import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface TestResult {
  name: string;
  duration: number;
  status: 'passed' | 'failed' | 'skipped';
  error?: string;
}

export interface TestRun {
  date: Date;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  tests: TestResult[];
}

export interface TestHealth {
  lastRun: Date;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  flakyTests: string[];
  averageRuntime: number;
  slowestTests: Array<{
    name: string;
    duration: number;
  }>;
  testHistory: TestRun[];
}

export class TestHealthMonitor {
  private healthDataPath: string;
  private maxHistorySize: number = 100;

  constructor(dataDir: string = '.test-health') {
    this.healthDataPath = path.join(dataDir, 'health.json');
    this.ensureDataDir();
  }

  private ensureDataDir(): void {
    const dir = path.dirname(this.healthDataPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  recordTestRun(results: TestRun): void {
    const health = this.getHealth();

    health.lastRun = new Date();
    health.totalTests = results.total;
    health.passedTests = results.passed;
    health.failedTests = results.failed;
    health.averageRuntime = results.duration;

    // Track slowest tests
    health.slowestTests = results.tests
      .filter((t) => t.duration > 1000)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10)
      .map((t) => ({ name: t.name, duration: t.duration }));

    // Add to history
    health.testHistory.push(results);
    if (health.testHistory.length > this.maxHistorySize) {
      health.testHistory = health.testHistory.slice(-this.maxHistorySize);
    }

    // Detect flaky tests
    this.updateFlakyTests(health);

    this.saveHealth(health);
  }

  private updateFlakyTests(health: TestHealth): void {
    const testResults = new Map<string, boolean[]>();

    // Look at last 10 runs
    const recentRuns = health.testHistory.slice(-10);

    for (const run of recentRuns) {
      for (const test of run.tests) {
        if (!testResults.has(test.name)) {
          testResults.set(test.name, []);
        }
        testResults.get(test.name)!.push(test.status === 'passed');
      }
    }

    // Find tests that have both passed and failed
    const flakyTests: string[] = [];
    for (const [testName, results] of testResults) {
      if (results.length >= 3) {
        const hasPassed = results.some((r) => r);
        const hasFailed = results.some((r) => !r);
        if (hasPassed && hasFailed) {
          const failureRate = results.filter((r) => !r).length / results.length;
          if (failureRate > 0.1 && failureRate < 0.9) {
            flakyTests.push(testName);
          }
        }
      }
    }

    health.flakyTests = flakyTests;
  }

  getHealth(): TestHealth {
    if (existsSync(this.healthDataPath)) {
      const data = JSON.parse(readFileSync(this.healthDataPath, 'utf-8'));
      // Convert dates
      data.lastRun = new Date(data.lastRun);
      data.testHistory = data.testHistory || [];
      data.testHistory.forEach((run: any) => {
        run.date = new Date(run.date);
      });
      return data;
    }

    return {
      lastRun: new Date(),
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      flakyTests: [],
      averageRuntime: 0,
      slowestTests: [],
      testHistory: [],
    };
  }

  private saveHealth(health: TestHealth): void {
    writeFileSync(this.healthDataPath, JSON.stringify(health, null, 2));
  }

  generateReport(): string {
    const health = this.getHealth();

    // Calculate trends
    const recentRuns = health.testHistory.slice(-5);
    const avgRecentDuration =
      recentRuns.length > 0
        ? recentRuns.reduce((sum, run) => sum + run.duration, 0) / recentRuns.length
        : 0;

    const successRate =
      health.totalTests > 0 ? ((health.passedTests / health.totalTests) * 100).toFixed(2) : '0';

    return `
# Test Health Report

Last Run: ${health.lastRun.toISOString()}
Total Tests: ${health.totalTests}
Passed: ${health.passedTests}
Failed: ${health.failedTests}
Success Rate: ${successRate}%
Average Runtime: ${health.averageRuntime}ms
Recent Average: ${avgRecentDuration.toFixed(0)}ms

## Slowest Tests
${health.slowestTests.map((t) => `- ${t.name}: ${t.duration}ms`).join('\n')}

## Flaky Tests (${health.flakyTests.length})
${health.flakyTests.length > 0 ? health.flakyTests.map((t) => `- ${t}`).join('\n') : 'None detected'}

## Test History (Last 5 Runs)
${recentRuns
  .map(
    (run) => `- ${run.date.toISOString()}: ${run.passed}/${run.total} passed (${run.duration}ms)`
  )
  .join('\n')}
    `.trim();
  }

  getTestTrends(): {
    successRateHistory: number[];
    durationHistory: number[];
    dates: Date[];
  } {
    const health = this.getHealth();
    const history = health.testHistory.slice(-30); // Last 30 runs

    return {
      successRateHistory: history.map((run) =>
        run.total > 0 ? (run.passed / run.total) * 100 : 0
      ),
      durationHistory: history.map((run) => run.duration),
      dates: history.map((run) => run.date),
    };
  }
}
