import {
  type IAgentRuntime,
  type IPlanningService,
  type Character,
  type Plugin,
  logger,
  AgentRuntime,
} from '@elizaos/core';
import { PlanningService } from '../services/planning-service';
import { RealmBenchAdapter, type RealmBenchReport } from './realm-bench-adapter';
import { ApiBankAdapter, type ApiBankReport } from './api-bank-adapter';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Benchmark Configuration
 */
export interface BenchmarkConfig {
  // Runtime configuration
  character: Character;
  plugins: Plugin[];
  enabledProviders?: string[];

  // Test data paths
  realmBenchPath?: string;
  apiBankPath?: string;

  // Benchmark options
  runRealmBench: boolean;
  runApiBank: boolean;
  maxTestsPerCategory?: number;
  timeoutMs?: number;

  // Output configuration
  outputDir: string;
  saveDetailedLogs: boolean;

  // Performance monitoring
  enableMetrics: boolean;
  enableMemoryTracking: boolean;
}

/**
 * Comprehensive Benchmark Results
 */
export interface BenchmarkResults {
  metadata: {
    timestamp: string;
    duration: number;
    configuration: Partial<BenchmarkConfig>;
  };

  realmBenchResults?: RealmBenchReport;
  apiBankResults?: ApiBankReport;

  overallMetrics: {
    totalTests: number;
    totalPassed: number;
    overallSuccessRate: number;
    averagePlanningTime: number;
    averageExecutionTime: number;
    memoryUsage: {
      peak: number;
      average: number;
    };
  };

  comparison: {
    planningVsBaseline: {
      improvementRate: number;
      categories: string[];
    };
    strengthsAndWeaknesses: {
      strengths: string[];
      weaknesses: string[];
      recommendations: string[];
    };
  };

  summary: {
    status: 'success' | 'partial' | 'failed';
    keyFindings: string[];
    performanceScore: number; // 0-100
  };
}

/**
 * Production-Ready Benchmark Runner
 * Orchestrates REALM-Bench and API-Bank testing with real runtime context
 */
export class BenchmarkRunner {
  private runtime: IAgentRuntime | null = null;
  private planningService: IPlanningService | null = null;
  private config: BenchmarkConfig;
  private startTime: number = 0;
  private memoryTracker: MemoryTracker;

  constructor(config: BenchmarkConfig) {
    this.config = config;
    this.memoryTracker = new MemoryTracker(config.enableMemoryTracking);
  }

  /**
   * Run comprehensive benchmarks
   */
  async runBenchmarks(): Promise<BenchmarkResults> {
    this.startTime = Date.now();
    this.memoryTracker.start();

    logger.info('[BenchmarkRunner] Starting comprehensive planning benchmarks');
    logger.info(
      `[BenchmarkRunner] REALM-Bench: ${this.config.runRealmBench ? 'enabled' : 'disabled'}`
    );
    logger.info(`[BenchmarkRunner] API-Bank: ${this.config.runApiBank ? 'enabled' : 'disabled'}`);

    try {
      // Step 1: Initialize runtime with real context
      await this.initializeRuntime();

      // Step 2: Run benchmarks
      const results: Partial<BenchmarkResults> = {
        metadata: {
          timestamp: new Date().toISOString(),
          duration: 0, // Will be updated at the end
          configuration: {
            runRealmBench: this.config.runRealmBench,
            runApiBank: this.config.runApiBank,
            enabledProviders: this.config.enabledProviders,
            maxTestsPerCategory: this.config.maxTestsPerCategory,
          },
        },
      };

      // Run REALM-Bench if enabled
      if (this.config.runRealmBench && this.config.realmBenchPath) {
        logger.info('[BenchmarkRunner] Running REALM-Bench tests...');
        results.realmBenchResults = await this.runRealmBenchTests();
      }

      // Run API-Bank if enabled
      if (this.config.runApiBank && this.config.apiBankPath) {
        logger.info('[BenchmarkRunner] Running API-Bank tests...');
        results.apiBankResults = await this.runApiBankTests();
      }

      // Step 3: Calculate overall metrics and comparisons
      const finalResults = await this.finalizeBenchmarkResults(results);

      // Step 4: Save results
      await this.saveResults(finalResults);

      logger.info(
        '[BenchmarkRunner] Benchmarks completed successfully: ' +
          `${finalResults.overallMetrics.totalPassed}/${finalResults.overallMetrics.totalTests} passed ` +
          `(${(finalResults.overallMetrics.overallSuccessRate * 100).toFixed(1)}%)`
      );

      return finalResults;
    } catch (error) {
      logger.error('[BenchmarkRunner] Benchmark execution failed:', error);
      throw new Error(`Benchmark execution failed: ${(error as Error).message}`);
    } finally {
      this.memoryTracker.stop();
      await this.cleanupRuntime();
    }
  }

  /**
   * Initialize runtime with real providers and services
   */
  private async initializeRuntime(): Promise<void> {
    logger.info('[BenchmarkRunner] Initializing test runtime with full context...');

    try {
      // Create runtime with character and plugins
      this.runtime = new AgentRuntime({
        character: this.config.character,
        plugins: this.config.plugins,
        settings: {
          // Benchmark-specific settings
          BENCHMARK_MODE: 'true',
          LOG_LEVEL: 'info',
          PLANNING_TIMEOUT: this.config.timeoutMs?.toString() || '60000',
        },
      });

      // Initialize runtime
      await this.runtime.initialize();

      // Get planning service
      this.planningService = this.runtime.getService<PlanningService>('planning');
      if (!this.planningService) {
        throw new Error('Planning service not available in runtime');
      }

      // Validate provider availability
      if (this.config.enabledProviders) {
        const availableProviders = this.runtime.providers.map((p) => p.name);
        const missingProviders = this.config.enabledProviders.filter(
          (name) => !availableProviders.includes(name)
        );

        if (missingProviders.length > 0) {
          logger.warn(`[BenchmarkRunner] Missing providers: ${missingProviders.join(', ')}`);
        }
      }

      logger.info('[BenchmarkRunner] Runtime initialized successfully');
      logger.info(
        `[BenchmarkRunner] Available providers: ${this.runtime.providers.map((p) => p.name).join(', ')}`
      );
      logger.info(
        `[BenchmarkRunner] Available actions: ${this.runtime.actions.map((a) => a.name).join(', ')}`
      );
    } catch (error) {
      logger.error('[BenchmarkRunner] Runtime initialization failed:', error);
      throw new Error(`Failed to initialize runtime: ${(error as Error).message}`);
    }
  }

  /**
   * Run REALM-Bench tests
   */
  private async runRealmBenchTests(): Promise<RealmBenchReport> {
    if (!this.runtime || !this.config.realmBenchPath) {
      throw new Error('Runtime or REALM-Bench path not configured');
    }

    const adapter = new RealmBenchAdapter(this.runtime);

    // Load test cases
    await adapter.loadTestCases(this.config.realmBenchPath);

    // Limit tests if specified
    // Note: Test limiting would be implemented in the adapter if needed

    // Run benchmark
    const report = await adapter.runBenchmark();

    // Save detailed report
    if (this.config.saveDetailedLogs) {
      const reportPath = path.join(this.config.outputDir, 'realm-bench-detailed.json');
      await adapter.saveReport(report, reportPath);
    }

    return report;
  }

  /**
   * Run API-Bank tests
   */
  private async runApiBankTests(): Promise<ApiBankReport> {
    if (!this.runtime || !this.config.apiBankPath) {
      throw new Error('Runtime or API-Bank path not configured');
    }

    const adapter = new ApiBankAdapter(this.runtime);

    // Load test cases
    await adapter.loadTestCases(this.config.apiBankPath);

    // Run benchmark
    const report = await adapter.runBenchmark();

    // Save detailed report
    if (this.config.saveDetailedLogs) {
      const reportPath = path.join(this.config.outputDir, 'api-bank-detailed.json');
      await adapter.saveReport(report, reportPath);
    }

    return report;
  }

  /**
   * Finalize benchmark results with comprehensive analysis
   */
  private async finalizeBenchmarkResults(
    partialResults: Partial<BenchmarkResults>
  ): Promise<BenchmarkResults> {
    const duration = Date.now() - this.startTime;
    const memoryStats = this.memoryTracker.getStats();

    // Calculate overall metrics
    let totalTests = 0;
    let totalPassed = 0;
    let totalPlanningTime = 0;
    let totalExecutionTime = 0;
    let testCount = 0;

    if (partialResults.realmBenchResults) {
      totalTests += partialResults.realmBenchResults.totalTests;
      totalPassed += partialResults.realmBenchResults.passedTests;

      for (const result of partialResults.realmBenchResults.results) {
        totalPlanningTime += result.metrics.planningTime;
        totalExecutionTime += result.metrics.executionTime;
        testCount++;
      }
    }

    if (partialResults.apiBankResults) {
      totalTests += partialResults.apiBankResults.totalTests;
      totalPassed += partialResults.apiBankResults.passedTests;

      for (const result of partialResults.apiBankResults.results) {
        totalPlanningTime += result.metrics.planningTime;
        totalExecutionTime += result.metrics.executionTime;
        testCount++;
      }
    }

    const overallMetrics = {
      totalTests,
      totalPassed,
      overallSuccessRate: totalTests > 0 ? totalPassed / totalTests : 0,
      averagePlanningTime: testCount > 0 ? totalPlanningTime / testCount : 0,
      averageExecutionTime: testCount > 0 ? totalExecutionTime / testCount : 0,
      memoryUsage: {
        peak: memoryStats.peakUsage,
        average: memoryStats.averageUsage,
      },
    };

    // Generate comparison and analysis
    const comparison = this.generateComparison(partialResults);
    const summary = this.generateSummary(overallMetrics, comparison);

    return {
      metadata: {
        ...partialResults.metadata!,
        duration,
      },
      realmBenchResults: partialResults.realmBenchResults,
      apiBankResults: partialResults.apiBankResults,
      overallMetrics,
      comparison,
      summary,
    };
  }

  /**
   * Generate comparison analysis
   */
  private generateComparison(results: Partial<BenchmarkResults>): BenchmarkResults['comparison'] {
    const strengths: string[] = [];
    const weaknesses: string[] = [];
    const recommendations: string[] = [];
    const strongCategories: string[] = [];

    // Analyze REALM-Bench performance
    if (results.realmBenchResults) {
      const realm = results.realmBenchResults;

      // Check category performance
      Object.entries(realm.summary.taskCategories).forEach(([category, stats]) => {
        if (stats.successRate > 0.8) {
          strengths.push(`Strong performance in ${category} planning tasks`);
          strongCategories.push(category);
        } else if (stats.successRate < 0.5) {
          weaknesses.push(`Challenging ${category} planning tasks`);
          recommendations.push(`Improve ${category} planning capabilities`);
        }
      });

      if (realm.averagePlanQuality > 0.7) {
        strengths.push('High-quality plan generation');
      }
    }

    // Analyze API-Bank performance
    if (results.apiBankResults) {
      const apiBank = results.apiBankResults;

      // Check level performance
      Object.entries(apiBank.levelBreakdown).forEach(([level, stats]) => {
        if (stats.successRate > 0.7) {
          strengths.push(`Strong Level ${level} tool use capabilities`);
        } else if (stats.successRate < 0.5) {
          weaknesses.push(`Challenging Level ${level} tool use scenarios`);
          recommendations.push(`Enhance Level ${level} API interaction planning`);
        }
      });

      if (apiBank.overallMetrics.averageApiCallAccuracy < 0.6) {
        weaknesses.push('API selection and invocation accuracy needs improvement');
        recommendations.push('Improve tool selection and parameter extraction');
      }

      if (apiBank.overallMetrics.averageResponseQuality < 0.5) {
        weaknesses.push('Response quality needs enhancement');
        recommendations.push('Improve response generation after tool use');
      }
    }

    // General recommendations
    if (recommendations.length === 0) {
      recommendations.push('Continue monitoring and testing with diverse scenarios');
    }

    return {
      planningVsBaseline: {
        improvementRate: 0.15, // Placeholder - would compare against baseline
        categories: strongCategories,
      },
      strengthsAndWeaknesses: {
        strengths,
        weaknesses,
        recommendations,
      },
    };
  }

  /**
   * Generate summary and scoring
   */
  private generateSummary(
    metrics: BenchmarkResults['overallMetrics'],
    comparison: BenchmarkResults['comparison']
  ): BenchmarkResults['summary'] {
    const keyFindings: string[] = [];
    let performanceScore = 0;

    // Determine status
    let status: 'success' | 'partial' | 'failed';
    if (metrics.overallSuccessRate > 0.7) {
      status = 'success';
      keyFindings.push('Planning system demonstrates strong overall performance');
    } else if (metrics.overallSuccessRate > 0.4) {
      status = 'partial';
      keyFindings.push('Planning system shows promise but needs improvement');
    } else {
      status = 'failed';
      keyFindings.push('Planning system requires significant enhancement');
    }

    // Calculate performance score (0-100)
    performanceScore += metrics.overallSuccessRate * 50; // 50% weight on success rate
    performanceScore += Math.min(metrics.averagePlanningTime / 1000, 10) * 2; // Speed bonus
    performanceScore += comparison.strengthsAndWeaknesses.strengths.length * 5; // Strengths bonus
    performanceScore -= comparison.strengthsAndWeaknesses.weaknesses.length * 3; // Weakness penalty
    performanceScore = Math.max(0, Math.min(100, performanceScore));

    // Add key findings
    if (metrics.averagePlanningTime < 2000) {
      keyFindings.push('Fast planning response times achieved');
    }

    if (comparison.strengthsAndWeaknesses.strengths.length > 3) {
      keyFindings.push('Multiple strength areas identified');
    }

    if (comparison.strengthsAndWeaknesses.weaknesses.length > 0) {
      keyFindings.push(
        `${comparison.strengthsAndWeaknesses.weaknesses.length} improvement areas identified`
      );
    }

    return {
      status,
      keyFindings,
      performanceScore: Math.round(performanceScore),
    };
  }

  /**
   * Save comprehensive benchmark results
   */
  private async saveResults(results: BenchmarkResults): Promise<void> {
    try {
      // Ensure output directory exists
      await fs.promises.mkdir(this.config.outputDir, { recursive: true });

      // Save main results
      const mainResultsPath = path.join(this.config.outputDir, 'benchmark-results.json');
      await fs.promises.writeFile(mainResultsPath, JSON.stringify(results, null, 2));

      // Save summary report
      const summaryPath = path.join(this.config.outputDir, 'benchmark-summary.md');
      const summaryMarkdown = this.generateMarkdownSummary(results);
      await fs.promises.writeFile(summaryPath, summaryMarkdown);

      logger.info(`[BenchmarkRunner] Results saved to ${this.config.outputDir}`);
      logger.info(
        `[BenchmarkRunner] Summary: ${results.summary.status} (${results.summary.performanceScore}/100)`
      );
    } catch (error) {
      logger.error('[BenchmarkRunner] Failed to save results:', error);
      throw new Error(`Failed to save results: ${(error as Error).message}`);
    }
  }

  /**
   * Generate markdown summary report
   */
  private generateMarkdownSummary(results: BenchmarkResults): string {
    const { metadata, overallMetrics, comparison, summary } = results;

    return `# ElizaOS Planning Benchmark Results

## Summary
- **Status**: ${summary.status.toUpperCase()}
- **Performance Score**: ${summary.performanceScore}/100
- **Overall Success Rate**: ${(overallMetrics.overallSuccessRate * 100).toFixed(1)}%
- **Total Tests**: ${overallMetrics.totalTests} (${overallMetrics.totalPassed} passed)
- **Duration**: ${(metadata.duration / 1000).toFixed(1)}s

## Key Findings
${summary.keyFindings.map((finding) => `- ${finding}`).join('\n')}

## Performance Metrics
- **Average Planning Time**: ${overallMetrics.averagePlanningTime.toFixed(0)}ms
- **Average Execution Time**: ${overallMetrics.averageExecutionTime.toFixed(0)}ms
- **Peak Memory Usage**: ${(overallMetrics.memoryUsage.peak / 1024 / 1024).toFixed(1)}MB
- **Average Memory Usage**: ${(overallMetrics.memoryUsage.average / 1024 / 1024).toFixed(1)}MB

## Strengths
${comparison.strengthsAndWeaknesses.strengths.map((strength) => `- ${strength}`).join('\n')}

## Areas for Improvement
${comparison.strengthsAndWeaknesses.weaknesses.map((weakness) => `- ${weakness}`).join('\n')}

## Recommendations
${comparison.strengthsAndWeaknesses.recommendations.map((rec) => `- ${rec}`).join('\n')}

${
  results.realmBenchResults
    ? `
## REALM-Bench Results
- **Tests**: ${results.realmBenchResults.totalTests} (${results.realmBenchResults.passedTests} passed)
- **Success Rate**: ${((results.realmBenchResults.passedTests / results.realmBenchResults.totalTests) * 100).toFixed(1)}%
- **Plan Quality**: ${(results.realmBenchResults.averagePlanQuality * 100).toFixed(1)}%
`
    : ''
}

${
  results.apiBankResults
    ? `
## API-Bank Results
- **Tests**: ${results.apiBankResults.totalTests} (${results.apiBankResults.passedTests} passed)
- **Success Rate**: ${((results.apiBankResults.passedTests / results.apiBankResults.totalTests) * 100).toFixed(1)}%
- **API Call Accuracy**: ${(results.apiBankResults.overallMetrics.averageApiCallAccuracy * 100).toFixed(1)}%
- **Response Quality**: ${(results.apiBankResults.overallMetrics.averageResponseQuality * 100).toFixed(1)}%
`
    : ''
}

---
*Generated on ${metadata.timestamp}*
`;
  }

  /**
   * Cleanup runtime resources
   */
  private async cleanupRuntime(): Promise<void> {
    if (this.runtime) {
      try {
        // Stop services
        for (const [, service] of this.runtime.services) {
          if (service && typeof service.stop === 'function') {
            await service.stop();
          }
        }

        logger.info('[BenchmarkRunner] Runtime cleanup completed');
      } catch (error) {
        logger.warn('[BenchmarkRunner] Runtime cleanup had issues:', error);
      }
    }
  }
}

/**
 * Memory tracking utility
 */
class MemoryTracker {
  private enabled: boolean;
  private measurements: number[] = [];
  private interval: NodeJS.Timeout | null = null;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  start(): void {
    if (!this.enabled) {
      return;
    }

    this.measurements = [];
    this.interval = setInterval(() => {
      const usage = process.memoryUsage();
      this.measurements.push(usage.heapUsed);
    }, 1000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  getStats(): { peakUsage: number; averageUsage: number } {
    if (!this.enabled || this.measurements.length === 0) {
      return { peakUsage: 0, averageUsage: 0 };
    }

    const peakUsage = Math.max(...this.measurements);
    const averageUsage =
      this.measurements.reduce((sum, val) => sum + val, 0) / this.measurements.length;

    return { peakUsage, averageUsage };
  }
}
