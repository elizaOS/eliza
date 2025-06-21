import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MetricsCollector, BenchmarkAnalyzer } from '../../../src/scenario-runner/metrics.js';
import { displayScenarioResults, saveResults } from '../../../src/commands/scenario/display.js';
import type { ScenarioContext, ScenarioResult, ScenarioMetrics } from '../../../src/scenario-runner/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

vi.mock('fs/promises');

describe('MetricsCollector', () => {
  let collector: MetricsCollector;
  let mockContext: ScenarioContext;

  beforeEach(() => {
    collector = new MetricsCollector();
    collector.start();

    mockContext = {
      scenario: {
        id: 'test-scenario',
        name: 'Test Scenario',
        description: 'Test',
        actors: [
          {
            id: 'actor1',
            role: 'subject',
            script: { steps: Array(5).fill({ type: 'message' }) },
          },
          {
            id: 'actor2',
            role: 'subject',
            script: { steps: Array(3).fill({ type: 'message' }) },
          },
        ],
        benchmarks: {
          customMetrics: ['unique_actors_engaged', 'conversation_turns'],
        },
      },
      transcript: [
        {
          id: '1',
          actorId: 'actor1',
          content: { text: 'Message 1' },
          timestamp: Date.now(),
          actorName: 'Actor 1',
          roomId: 'room1',
          messageType: 'outgoing',
        },
        {
          id: '2',
          actorId: 'actor2',
          content: { text: 'Message 2' },
          timestamp: Date.now(),
          actorName: 'Actor 2',
          roomId: 'room1',
          messageType: 'incoming',
        },
        {
          id: '3',
          actorId: 'actor1',
          content: { text: 'Message 3' },
          timestamp: Date.now(),
          actorName: 'Actor 1',
          roomId: 'room1',
          messageType: 'outgoing',
        },
      ],
    } as any;
  });

  describe('collect', () => {
    it('should collect basic metrics', () => {
      const metrics = collector.collect(mockContext);

      expect(metrics.duration).toBeGreaterThan(0);
      expect(metrics.messageCount).toBe(3);
      expect(metrics.stepCount).toBe(8); // 5 + 3 steps
      expect(metrics.tokenUsage).toBeDefined();
      expect(metrics.memoryUsage).toBeDefined();
      expect(metrics.actionCounts).toBeDefined();
      expect(metrics.responseLatency).toBeDefined();
    });

    it('should track response latencies', () => {
      collector.recordResponseLatency(100);
      collector.recordResponseLatency(200);
      collector.recordResponseLatency(150);

      const metrics = collector.collect(mockContext);

      expect(metrics.responseLatency.min).toBe(100);
      expect(metrics.responseLatency.max).toBe(200);
      expect(metrics.responseLatency.average).toBe(150);
      expect(metrics.responseLatency.p95).toBeGreaterThanOrEqual(150);
    });

    it('should track token usage', () => {
      collector.recordTokenUsage({ input: 100, output: 50, total: 150 });
      collector.recordTokenUsage({ input: 200, output: 100, total: 300, cost: 0.001 });

      const metrics = collector.collect(mockContext);

      expect(metrics.tokenUsage.input).toBe(300);
      expect(metrics.tokenUsage.output).toBe(150);
      expect(metrics.tokenUsage.total).toBe(450);
      expect(metrics.tokenUsage.cost).toBe(0.001);
    });

    it('should track actions', () => {
      collector.recordAction('RESEARCH');
      collector.recordAction('CREATE_TODO');
      collector.recordAction('RESEARCH');

      const metrics = collector.collect(mockContext);

      expect(metrics.actionCounts['RESEARCH']).toBe(2);
      expect(metrics.actionCounts['CREATE_TODO']).toBe(1);
    });

    it('should track memory usage', () => {
      collector.recordMemoryUsage(100);
      collector.recordMemoryUsage(200);
      collector.recordMemoryUsage(150);

      const metrics = collector.collect(mockContext);

      expect(metrics.memoryUsage.peak).toBe(200);
      expect(metrics.memoryUsage.average).toBe(150);
      expect(metrics.memoryUsage.memoryOperations).toBe(3);
    });

    it('should collect custom metrics', () => {
      const metrics = collector.collect(mockContext);

      expect(metrics.customMetrics).toBeDefined();
      expect(metrics.customMetrics!['unique_actors_engaged']).toBe(2);
      expect(metrics.customMetrics!['conversation_turns']).toBe(3);
    });
  });
});

describe('BenchmarkAnalyzer', () => {
  let analyzer: BenchmarkAnalyzer;
  let mockMetrics: ScenarioMetrics;
  let mockScenario: any;

  beforeEach(() => {
    analyzer = new BenchmarkAnalyzer();

    mockMetrics = {
      duration: 5000,
      messageCount: 10,
      stepCount: 8,
      tokenUsage: { input: 1000, output: 500, total: 1500 },
      memoryUsage: { peak: 100, average: 80, memoryOperations: 10 },
      actionCounts: { RESEARCH: 2, CREATE_TODO: 1 },
      responseLatency: { min: 100, max: 500, average: 250, p95: 450 },
    };

    mockScenario = {
      benchmarks: {
        maxDuration: 10000,
        targetAccuracy: 0.9,
      },
    };
  });

  describe('calculatePerformanceScore', () => {
    it('should calculate overall performance score', () => {
      const score = analyzer.calculatePerformanceScore(mockMetrics, mockScenario);

      expect(score.overall).toBeGreaterThan(0);
      expect(score.overall).toBeLessThanOrEqual(1);
      expect(score.speed).toBeDefined();
      expect(score.accuracy).toBeDefined();
      expect(score.efficiency).toBeDefined();
      expect(score.reliability).toBeDefined();
    });

    it('should calculate speed score based on duration', () => {
      const score = analyzer.calculatePerformanceScore(mockMetrics, mockScenario);
      expect(score.speed).toBeGreaterThan(0.5); // 5s out of 10s max

      // Test with slower execution
      mockMetrics.duration = 15000;
      const slowerScore = analyzer.calculatePerformanceScore(mockMetrics, mockScenario);
      expect(slowerScore.speed).toBeLessThan(score.speed);
    });
  });

  describe('generateBenchmarkReport', () => {
    it('should generate a complete benchmark report', () => {
      const performance = analyzer.calculatePerformanceScore(mockMetrics, mockScenario);
      const report = analyzer.generateBenchmarkReport(
        'scenario-1',
        'Test Scenario',
        mockMetrics,
        performance
      );

      expect(report.scenarioId).toBe('scenario-1');
      expect(report.scenarioName).toBe('Test Scenario');
      expect(report.timestamp).toBeDefined();
      expect(report.metrics).toBe(mockMetrics);
      expect(report.performance).toBe(performance);
      expect(report.artifacts).toBeInstanceOf(Array);
    });
  });

  describe('compareToBaseline', () => {
    it('should compare metrics to baseline', () => {
      const baselineMetrics = {
        ...mockMetrics,
        duration: 6000,
        tokenUsage: { input: 1200, output: 600, total: 1800 },
      };

      const comparison = analyzer.compareToBaseline(mockMetrics, baselineMetrics, '1.0.0');

      expect(comparison.baselineVersion).toBe('1.0.0');
      expect(comparison.improvement).toBeGreaterThan(0); // Should show improvement
      expect(comparison.improvements).toContain('Response time improved by');
      expect(comparison.improvements).toContain('Token usage reduced by');
    });

    it('should detect regressions', () => {
      const baselineMetrics = {
        ...mockMetrics,
        duration: 3000,
        tokenUsage: { input: 800, output: 400, total: 1200 },
      };

      const comparison = analyzer.compareToBaseline(mockMetrics, baselineMetrics, '1.0.0');

      expect(comparison.improvement).toBeLessThan(0); // Should show regression
      expect(comparison.regression).toContain('Response time regressed by');
      expect(comparison.regression).toContain('Token usage increased by');
    });
  });
});

describe('Display Functions', () => {
  let mockResults: ScenarioResult[];
  let mockOptions: any;

  beforeEach(() => {
    mockResults = [
      {
        scenarioId: 'test-1',
        name: 'Test Scenario 1',
        startTime: Date.now() - 5000,
        endTime: Date.now(),
        duration: 5000,
        passed: true,
        score: 0.9,
        metrics: {
          duration: 5000,
          messageCount: 10,
          stepCount: 8,
          tokenUsage: { input: 1000, output: 500, total: 1500 },
          memoryUsage: { peak: 100, average: 80, memoryOperations: 10 },
          actionCounts: { RESEARCH: 2 },
          responseLatency: { min: 100, max: 500, average: 250, p95: 450 },
        },
        verificationResults: [
          {
            ruleId: 'rule-1',
            ruleName: 'Test Rule',
            passed: true,
            score: 0.9,
            reason: 'Test passed successfully',
          },
        ],
        transcript: [],
      },
      {
        scenarioId: 'test-2',
        name: 'Test Scenario 2',
        startTime: Date.now() - 3000,
        endTime: Date.now(),
        duration: 3000,
        passed: false,
        score: 0.4,
        metrics: {
          duration: 3000,
          messageCount: 5,
          stepCount: 4,
          tokenUsage: { input: 500, output: 250, total: 750 },
          memoryUsage: { peak: 50, average: 40, memoryOperations: 5 },
          actionCounts: {},
          responseLatency: { min: 200, max: 600, average: 350, p95: 550 },
        },
        verificationResults: [
          {
            ruleId: 'rule-2',
            ruleName: 'Test Rule 2',
            passed: false,
            score: 0.4,
            reason: 'Test failed due to timeout',
          },
        ],
        transcript: [],
        errors: ['Timeout error'],
      },
    ];

    mockOptions = {
      verbose: true,
      benchmark: true,
    };

    // Capture console output
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('displayScenarioResults', () => {
    it('should display results summary', () => {
      displayScenarioResults(mockResults, mockOptions);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Scenario Test Results'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Test Scenario 1'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Test Scenario 2'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Summary'));
    });

    it('should display benchmark metrics when enabled', () => {
      displayScenarioResults(mockResults, mockOptions);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Benchmark Metrics'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Total Tokens Used'));
    });
  });

  describe('saveResults', () => {
    beforeEach(() => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    });

    it('should save results as JSON', async () => {
      await saveResults(mockResults, '/tmp/results.json', 'json');

      expect(fs.mkdir).toHaveBeenCalledWith(path.dirname('/tmp/results.json'), { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(
        '/tmp/results.json',
        expect.stringContaining('"timestamp"'),
      );
    });

    it('should save results as text', async () => {
      await saveResults(mockResults, '/tmp/results.txt', 'text');

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/tmp/results.txt',
        expect.stringContaining('Scenario Test Results'),
      );
    });

    it('should save results as HTML', async () => {
      await saveResults(mockResults, '/tmp/results.html', 'html');

      expect(fs.writeFile).toHaveBeenCalledWith(
        '/tmp/results.html',
        expect.stringContaining('<!DOCTYPE html>'),
      );
    });
  });
}); 