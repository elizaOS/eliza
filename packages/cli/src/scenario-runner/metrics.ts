import type {
  ScenarioMetrics,
  TokenUsage,
  MemoryUsage,
  LatencyMetrics,
  ScenarioContext,
  PerformanceScore,
  BenchmarkReport,
  BaselineComparison,
} from './types.js';

export class MetricsCollector {
  private startTime: number = 0;
  private responseLatencies: number[] = [];
  private tokenCounts: TokenUsage = { input: 0, output: 0, total: 0 };
  private memoryPeaks: number[] = [];
  private actionCounts: Record<string, number> = {};

  start(): void {
    this.startTime = Date.now();
    this.reset();
  }

  private reset(): void {
    this.responseLatencies = [];
    this.tokenCounts = { input: 0, output: 0, total: 0 };
    this.memoryPeaks = [];
    this.actionCounts = {};
  }

  recordResponseLatency(latency: number): void {
    this.responseLatencies.push(latency);
  }

  recordTokenUsage(usage: TokenUsage): void {
    this.tokenCounts.input += usage.input;
    this.tokenCounts.output += usage.output;
    this.tokenCounts.total += usage.total;
    if (usage.cost) {
      this.tokenCounts.cost = (this.tokenCounts.cost || 0) + usage.cost;
    }
  }

  recordMemoryUsage(usage: number): void {
    this.memoryPeaks.push(usage);
  }

  recordAction(actionName: string): void {
    this.actionCounts[actionName] = (this.actionCounts[actionName] || 0) + 1;
  }

  collect(context: ScenarioContext): ScenarioMetrics {
    const duration = Date.now() - this.startTime;

    return {
      duration,
      messageCount: context.transcript.length,
      stepCount: this.calculateStepCount(context),
      tokenUsage: this.tokenCounts,
      memoryUsage: this.calculateMemoryUsage(),
      actionCounts: { ...this.actionCounts },
      responseLatency: this.calculateLatencyMetrics(),
      customMetrics: this.collectCustomMetrics(context),
    };
  }

  private calculateStepCount(context: ScenarioContext): number {
    // Count total script steps executed across all actors
    return context.scenario.actors.reduce((total, actor) => {
      return total + (actor.script?.steps.length || 0);
    }, 0);
  }

  private calculateMemoryUsage(): MemoryUsage {
    const peak = Math.max(...this.memoryPeaks, 0);
    const average =
      this.memoryPeaks.length > 0
        ? this.memoryPeaks.reduce((sum, val) => sum + val, 0) / this.memoryPeaks.length
        : 0;

    return {
      peak,
      average,
      memoryOperations: this.memoryPeaks.length,
    };
  }

  private calculateLatencyMetrics(): LatencyMetrics {
    if (this.responseLatencies.length === 0) {
      return { min: 0, max: 0, average: 0, p95: 0 };
    }

    const sorted = [...this.responseLatencies].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const average = sorted.reduce((sum, val) => sum + val, 0) / sorted.length;
    const p95Index = Math.floor(sorted.length * 0.95);
    const p95 = sorted[p95Index];

    return { min, max, average, p95 };
  }

  private collectCustomMetrics(context: ScenarioContext): Record<string, any> {
    const metrics: Record<string, any> = {};

    // Add scenario-specific metrics
    if (context.scenario.benchmarks?.customMetrics) {
      for (const metric of context.scenario.benchmarks.customMetrics) {
        const metricName = metric.name;
        switch (metricName) {
          case 'unique_actors_engaged':
            metrics[metricName] = new Set(context.transcript.map((msg) => msg.actorId)).size;
            break;
          case 'conversation_turns':
            metrics[metricName] = this.calculateConversationTurns(context);
            break;
          case 'subject_response_rate':
            metrics[metricName] = this.calculateSubjectResponseRate(context);
            break;
          default:
            // Custom metric implementation would go here
            break;
        }
      }
    }

    return metrics;
  }

  private calculateConversationTurns(context: ScenarioContext): number {
    let turns = 0;
    let lastActorId = '';

    for (const message of context.transcript) {
      if (message.actorId !== lastActorId) {
        turns++;
        lastActorId = message.actorId;
      }
    }

    return turns;
  }

  private calculateSubjectResponseRate(context: ScenarioContext): number {
    const subjectActor = context.scenario.actors.find((a) => a.role === 'subject');
    if (!subjectActor) return 0;

    const totalMessages = context.transcript.length;
    const subjectMessages = context.transcript.filter(
      (msg) => msg.actorId === subjectActor.id
    ).length;

    return totalMessages > 0 ? subjectMessages / totalMessages : 0;
  }
}

export class BenchmarkAnalyzer {
  calculatePerformanceScore(metrics: ScenarioMetrics, scenario: any): PerformanceScore {
    const speedScore = this.calculateSpeedScore(metrics, scenario.benchmarks);
    const accuracyScore = this.calculateAccuracyScore(metrics);
    const efficiencyScore = this.calculateEfficiencyScore(metrics);
    const reliabilityScore = this.calculateReliabilityScore(metrics);

    const overall = (speedScore + accuracyScore + efficiencyScore + reliabilityScore) / 4;

    return {
      overall: Math.round(overall * 100) / 100,
      speed: speedScore,
      accuracy: accuracyScore,
      efficiency: efficiencyScore,
      reliability: reliabilityScore,
    };
  }

  private calculateSpeedScore(metrics: ScenarioMetrics, benchmarks: any): number {
    if (!benchmarks.maxDuration) return 1.0;

    const ratio = metrics.duration / benchmarks.maxDuration;
    return Math.max(0, Math.min(1, 2 - ratio)); // Score decreases as duration increases
  }

  private calculateAccuracyScore(_metrics: ScenarioMetrics): number {
    // This would be calculated based on verification results
    // For now, return a placeholder
    return 0.8;
  }

  private calculateEfficiencyScore(metrics: ScenarioMetrics): number {
    // Based on token usage and memory efficiency
    const tokenEfficiency = Math.min(1, 1000 / metrics.tokenUsage.total); // Arbitrary baseline
    const memoryEfficiency = Math.min(1, 100 / metrics.memoryUsage.peak); // Arbitrary baseline

    return (tokenEfficiency + memoryEfficiency) / 2;
  }

  private calculateReliabilityScore(metrics: ScenarioMetrics): number {
    // Based on consistency of response latencies
    const latencyVariance = this.calculateVariance(metrics.responseLatency.average, [
      metrics.responseLatency.min,
      metrics.responseLatency.max,
    ]);

    return Math.max(0, 1 - latencyVariance / 1000); // Lower variance = higher reliability
  }

  private calculateVariance(mean: number, values: number[]): number {
    if (values.length === 0) return 0;

    const squaredDiffs = values.map((value) => Math.pow(value - mean, 2));
    return squaredDiffs.reduce((sum, diff) => sum + diff, 0) / values.length;
  }

  generateBenchmarkReport(
    scenarioId: string,
    scenarioName: string,
    metrics: ScenarioMetrics,
    performance: PerformanceScore,
    baseline?: BaselineComparison
  ): BenchmarkReport {
    return {
      scenarioId,
      scenarioName,
      timestamp: Date.now(),
      metrics,
      performance,
      comparison: baseline,
      artifacts: this.generateArtifacts(metrics),
    };
  }

  private generateArtifacts(metrics: ScenarioMetrics): string[] {
    const artifacts: string[] = [];

    // Generate performance charts, logs, etc.
    if (metrics.responseLatency.average > 0) {
      artifacts.push('latency_chart.png');
    }

    if (metrics.tokenUsage.total > 0) {
      artifacts.push('token_usage_report.json');
    }

    return artifacts;
  }

  compareToBaseline(
    currentMetrics: ScenarioMetrics,
    baselineMetrics: ScenarioMetrics,
    baselineVersion: string
  ): BaselineComparison {
    const durationImprovement =
      (baselineMetrics.duration - currentMetrics.duration) / baselineMetrics.duration;
    const tokenImprovement =
      (baselineMetrics.tokenUsage.total - currentMetrics.tokenUsage.total) /
      baselineMetrics.tokenUsage.total;

    const overall = (durationImprovement + tokenImprovement) / 2;

    const improvements: string[] = [];
    const regressions: string[] = [];

    if (durationImprovement > 0.05) {
      improvements.push(`Response time improved by ${Math.round(durationImprovement * 100)}%`);
    } else if (durationImprovement < -0.05) {
      regressions.push(
        `Response time regressed by ${Math.round(Math.abs(durationImprovement) * 100)}%`
      );
    }

    if (tokenImprovement > 0.05) {
      improvements.push(`Token usage reduced by ${Math.round(tokenImprovement * 100)}%`);
    } else if (tokenImprovement < -0.05) {
      regressions.push(`Token usage increased by ${Math.round(Math.abs(tokenImprovement) * 100)}%`);
    }

    return {
      baselineVersion,
      improvement: overall,
      improvements,
      regression: regressions,
    };
  }
}
