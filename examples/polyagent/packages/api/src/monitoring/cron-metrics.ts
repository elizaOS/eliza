/**
 * Cron Job Metrics Service
 *
 * Tracks cron execution metrics for monitoring and alerting.
 * Provides structured data for dashboards and observability.
 *
 * @module monitoring/cron-metrics
 */

import { logger } from "@polyagent/shared";

export interface CronExecutionMetrics {
  jobName: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  success: boolean;
  skipped: boolean;
  skipReason?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface CronJobStats {
  jobName: string;
  totalExecutions: number;
  successfulExecutions: number;
  skippedExecutions: number;
  failedExecutions: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  lastExecution?: Date;
  lastSuccess?: Date;
  lastFailure?: Date;
  consecutiveFailures: number;
}

interface InternalJobStats {
  jobName: string;
  executions: CronExecutionMetrics[];
  consecutiveFailures: number;
  lastSuccess?: Date;
  lastFailure?: Date;
}

const METRICS_WINDOW_SIZE = 100; // Keep last 100 executions per job

class CronMetricsService {
  private jobStats: Map<string, InternalJobStats> = new Map();
  private alertCallbacks: Array<
    (metrics: CronExecutionMetrics) => Promise<void>
  > = [];

  /**
   * Record a cron job execution
   */
  recordExecution(metrics: CronExecutionMetrics): void {
    const { jobName } = metrics;

    let stats = this.jobStats.get(jobName);
    if (!stats) {
      stats = {
        jobName,
        executions: [],
        consecutiveFailures: 0,
      };
      this.jobStats.set(jobName, stats);
    }

    // Add execution to history
    stats.executions.push(metrics);

    // Trim to window size
    if (stats.executions.length > METRICS_WINDOW_SIZE) {
      stats.executions.shift();
    }

    // Update consecutive failures
    if (!metrics.success && !metrics.skipped) {
      stats.consecutiveFailures++;
      stats.lastFailure = metrics.endTime;
    } else if (metrics.success) {
      stats.consecutiveFailures = 0;
      stats.lastSuccess = metrics.endTime;
    }

    // Log execution
    const logLevel =
      !metrics.success && !metrics.skipped
        ? "error"
        : metrics.skipped
          ? "info"
          : "info";

    logger[logLevel](
      `Cron ${jobName}: ${metrics.success ? "✅" : metrics.skipped ? "⏭️" : "❌"} ${metrics.durationMs}ms`,
      {
        jobName,
        durationMs: metrics.durationMs,
        success: metrics.success,
        skipped: metrics.skipped,
        skipReason: metrics.skipReason,
        error: metrics.error,
        consecutiveFailures: stats.consecutiveFailures,
      },
      "CronMetrics",
    );

    // Fire alert callbacks if failed
    if (!metrics.success && !metrics.skipped) {
      this.fireAlerts(metrics);
    }
  }

  /**
   * Get stats for a specific job
   */
  getJobStats(jobName: string): CronJobStats | null {
    const stats = this.jobStats.get(jobName);
    if (!stats || stats.executions.length === 0) {
      return null;
    }

    const executions = stats.executions;
    const successful = executions.filter((e) => e.success);
    const skipped = executions.filter((e) => e.skipped);
    const failed = executions.filter((e) => !e.success && !e.skipped);
    const durations = executions
      .filter((e) => !e.skipped)
      .map((e) => e.durationMs);

    return {
      jobName,
      totalExecutions: executions.length,
      successfulExecutions: successful.length,
      skippedExecutions: skipped.length,
      failedExecutions: failed.length,
      avgDurationMs:
        durations.length > 0
          ? durations.reduce((a, b) => a + b, 0) / durations.length
          : 0,
      minDurationMs: durations.length > 0 ? Math.min(...durations) : 0,
      maxDurationMs: durations.length > 0 ? Math.max(...durations) : 0,
      lastExecution: executions[executions.length - 1]?.endTime,
      lastSuccess: stats.lastSuccess,
      lastFailure: stats.lastFailure,
      consecutiveFailures: stats.consecutiveFailures,
    };
  }

  /**
   * Get stats for all jobs
   */
  getAllJobStats(): CronJobStats[] {
    const allStats: CronJobStats[] = [];

    for (const jobName of this.jobStats.keys()) {
      const stats = this.getJobStats(jobName);
      if (stats) {
        allStats.push(stats);
      }
    }

    return allStats;
  }

  /**
   * Get aggregated metrics for dashboard
   */
  getDashboardMetrics(): {
    jobs: CronJobStats[];
    summary: {
      totalJobs: number;
      healthyJobs: number;
      unhealthyJobs: number;
      totalExecutions: number;
      overallSuccessRate: number;
      avgDurationMs: number;
    };
    alerts: Array<{
      jobName: string;
      type: "consecutive_failures" | "high_duration" | "no_recent_execution";
      message: string;
      severity: "warning" | "critical";
    }>;
  } {
    const jobs = this.getAllJobStats();
    const alerts: Array<{
      jobName: string;
      type: "consecutive_failures" | "high_duration" | "no_recent_execution";
      message: string;
      severity: "warning" | "critical";
    }> = [];

    let totalExecutions = 0;
    let totalSuccesses = 0;
    let totalDuration = 0;
    let durationCount = 0;

    for (const job of jobs) {
      totalExecutions += job.totalExecutions;
      totalSuccesses += job.successfulExecutions;

      if (job.avgDurationMs > 0) {
        totalDuration +=
          job.avgDurationMs * (job.totalExecutions - job.skippedExecutions);
        durationCount += job.totalExecutions - job.skippedExecutions;
      }

      // Generate alerts
      if (job.consecutiveFailures >= 3) {
        alerts.push({
          jobName: job.jobName,
          type: "consecutive_failures",
          message: `${job.consecutiveFailures} consecutive failures`,
          severity: job.consecutiveFailures >= 5 ? "critical" : "warning",
        });
      }

      if (job.maxDurationMs > 600000) {
        // > 10 minutes
        alerts.push({
          jobName: job.jobName,
          type: "high_duration",
          message: `Max duration ${Math.round(job.maxDurationMs / 1000)}s exceeds 10 minute threshold`,
          severity: job.maxDurationMs > 700000 ? "critical" : "warning",
        });
      }

      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      if (
        job.lastExecution &&
        job.lastExecution < fiveMinutesAgo &&
        ["game-tick", "agent-tick", "realtime-drain"].includes(job.jobName)
      ) {
        alerts.push({
          jobName: job.jobName,
          type: "no_recent_execution",
          message: `No execution in last 5 minutes`,
          severity: "warning",
        });
      }
    }

    const healthyJobs = jobs.filter((j) => j.consecutiveFailures < 3).length;

    return {
      jobs,
      summary: {
        totalJobs: jobs.length,
        healthyJobs,
        unhealthyJobs: jobs.length - healthyJobs,
        totalExecutions,
        overallSuccessRate:
          totalExecutions > 0 ? (totalSuccesses / totalExecutions) * 100 : 100,
        avgDurationMs: durationCount > 0 ? totalDuration / durationCount : 0,
      },
      alerts,
    };
  }

  /**
   * Register alert callback for failed executions
   */
  onAlert(callback: (metrics: CronExecutionMetrics) => Promise<void>): void {
    this.alertCallbacks.push(callback);
  }

  /**
   * Fire alert callbacks
   */
  private async fireAlerts(metrics: CronExecutionMetrics): Promise<void> {
    for (const callback of this.alertCallbacks) {
      try {
        await callback(metrics);
      } catch (error) {
        logger.error(
          "Failed to fire cron alert callback",
          { error: String(error) },
          "CronMetrics",
        );
      }
    }
  }

  /**
   * Helper to wrap cron execution with metrics recording
   */
  async trackExecution<T>(
    jobName: string,
    executor: () => Promise<T>,
    getMetadata?: (result: T) => Record<string, unknown>,
  ): Promise<T> {
    const startTime = new Date();

    try {
      const result = await executor();

      const endTime = new Date();
      const metadata = getMetadata ? getMetadata(result) : undefined;

      // Determine if skipped from result structure
      const resultObj = result as Record<string, unknown>;
      const skipped = Boolean(resultObj?.skipped);
      const skipReason = resultObj?.reason as string | undefined;

      this.recordExecution({
        jobName,
        startTime,
        endTime,
        durationMs: endTime.getTime() - startTime.getTime(),
        success: !skipped,
        skipped,
        skipReason,
        metadata,
      });

      return result;
    } catch (error) {
      const endTime = new Date();

      this.recordExecution({
        jobName,
        startTime,
        endTime,
        durationMs: endTime.getTime() - startTime.getTime(),
        success: false,
        skipped: false,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * Reset all metrics (for testing)
   */
  reset(): void {
    this.jobStats.clear();
  }
}

// Export singleton instance
export const cronMetrics = new CronMetricsService();

// Export helper function for use in cron handlers
export function recordCronExecution(
  jobName: string,
  startTime: Date,
  result: {
    success: boolean;
    skipped?: boolean;
    reason?: string;
    error?: string;
    [key: string]: unknown;
  },
): void {
  const endTime = new Date();

  cronMetrics.recordExecution({
    jobName,
    startTime,
    endTime,
    durationMs: endTime.getTime() - startTime.getTime(),
    success: result.success && !result.skipped,
    skipped: Boolean(result.skipped),
    skipReason: result.reason,
    error: result.error,
    metadata: result,
  });
}
