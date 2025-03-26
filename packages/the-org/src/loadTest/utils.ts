import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '@elizaos/core';
import { LoadTestMetrics, ScaleConfig } from './types';

/**
 * Threshold configurations for breaking point detection
 */
export enum ThresholdLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

export interface ThresholdConfig {
  responseTimeThreshold: number; // in ms
  errorRateThreshold: number; // as a percentage (0-100)
  successRateThreshold: number; // as a percentage (0-100)
  memoryThreshold: number; // in MB
  cpuThreshold: number; // as a fraction (0-1)
}

export const THRESHOLD_CONFIGS: Record<ThresholdLevel, ThresholdConfig> = {
  [ThresholdLevel.LOW]: {
    responseTimeThreshold: 3000, // 3 seconds
    errorRateThreshold: 5, // 5%
    successRateThreshold: 95, // 95%
    memoryThreshold: 768, // 768MB
    cpuThreshold: 0.7, // 70%
  },
  [ThresholdLevel.MEDIUM]: {
    responseTimeThreshold: 5000, // 5 seconds
    errorRateThreshold: 10, // 10%
    successRateThreshold: 90, // 90%
    memoryThreshold: 1024, // 1GB
    cpuThreshold: 0.8, // 80%
  },
  [ThresholdLevel.HIGH]: {
    responseTimeThreshold: 8000, // 8 seconds
    errorRateThreshold: 20, // 20%
    successRateThreshold: 80, // 80%
    memoryThreshold: 1536, // 1.5GB
    cpuThreshold: 0.9, // 90%
  },
};

/**
 * Ensures the logs directory exists and returns the path
 */
export function ensureLogsDirectory(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const logsDir = path.join(__dirname, 'logs');

  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
    logger.info(`Created logs directory at ${logsDir}`);
  }

  return logsDir;
}

/**
 * Create a timestamp string for file naming
 */
export function generateTimestamp(): string {
  return new Date().toISOString().replace(/:/g, '-');
}

/**
 * Generate a scalability analysis header for log files
 */
export function createScalabilityAnalysisHeader(): string {
  return (
    `AGENT SCALABILITY ANALYSIS\n` +
    `=======================\n` +
    `Started: ${new Date().toISOString()}\n\n` +
    `This test suite runs progressively larger load tests to identify breaking points:\n` +
    `- 2 agents (baseline)\n` +
    `- 5 agents (small group)\n` +
    `- 10 agents (medium group)\n` +
    `- 50 agents (large group)\n` +
    `- 100 agents (very large group)\n` +
    `- 250 agents (mass scale)\n` +
    `- 500 agents (extreme scale)\n` +
    `- 1000 agents (maximum load)\n` +
    `- 2000 agents (breaking point test)\n\n` +
    `OBJECTIVE: Identify thresholds and optimize for scalability\n\n` +
    `TESTING LOG:\n` +
    `===========\n\n`
  );
}

/**
 * Create a summary file header for load test results
 */
export function createLoadTestSummaryHeader(): string {
  return (
    'Scale Testing Summary - Finding Breaking Points\n' +
    '===========================================\n' +
    `Test Started: ${new Date().toISOString()}\n\n` +
    'Configuration | Agents | Messages | Success Rate | Avg Response | Memory | Throughput | Errors\n' +
    '-------------|--------|----------|--------------|--------------|--------|------------|-------\n'
  );
}

/**
 * Create a detailed test log header
 */
export function createDetailedTestLogHeader(config: ScaleConfig): string {
  return (
    `Load Test: ${config.description}\n` +
    `================${'='.repeat(config.description.length)}\n` +
    `Agents: ${config.agents}\n` +
    `Messages: ${config.messageCount}\n` +
    `Started: ${new Date().toISOString()}\n\n` +
    'DETAILED TEST LOG:\n' +
    '=================\n\n'
  );
}

/**
 * Format a breaking point notification
 */
export function formatBreakingPointNotification(
  metrics: LoadTestMetrics,
  thresholdLevel: ThresholdLevel
): string {
  const thresholds = THRESHOLD_CONFIGS[thresholdLevel];
  return (
    `\n*** BREAKING POINT IDENTIFIED WITH ${thresholdLevel} THRESHOLD ***\n` +
    `Threshold configuration: ${thresholdLevel}\n` +
    `Response time threshold: ${thresholds.responseTimeThreshold}ms (actual: ${metrics.avgResponseTime.toFixed(2)}ms)\n` +
    `Error rate threshold: ${thresholds.errorRateThreshold}% (actual: ${((metrics.errorCount / metrics.messagesSent) * 100).toFixed(2)}%)\n` +
    `Success rate threshold: ${thresholds.successRateThreshold}% (actual: ${metrics.successRate.toFixed(2)}%)\n` +
    `Memory threshold: ${thresholds.memoryThreshold}MB (peak: ${metrics.peakMemoryUsage.toFixed(2)}MB)\n`
  );
}

/**
 * Format a scalability conclusions section
 */
export function formatScalabilityConclusions(conclusions: string): string {
  return (
    `\n\nSCALABILITY CONCLUSIONS\n` +
    `======================\n\n` +
    conclusions +
    '\n\n' +
    `For detailed metrics on each test configuration, see the individual test logs.\n`
  );
}

/**
 * Format a visualization guide section
 */
export function formatVisualizationGuide(): string {
  return (
    `\n\nVISUALIZATION\n` +
    `=============\n` +
    `To visualize the scalability results, you can plot the following metrics:\n` +
    `1. Success Rate vs. Agent Count\n` +
    `2. Response Time vs. Agent Count\n` +
    `3. Throughput vs. Agent Count\n` +
    `4. Error Rate vs. Agent Count\n\n` +
    `The optimal configuration is typically just before the breaking point where:\n` +
    `- Success rate is still high (>95%)\n` +
    `- Response times remain reasonable (<1000ms)\n` +
    `- Throughput is maximized\n\n` +
    `Test completed at: ${new Date().toISOString()}\n` +
    `=================\n\n`
  );
}

/**
 * Format an error message for the log file
 */
export function formatErrorMessage(error: any): string {
  return (
    `\n\nERROR DURING TESTING:\n` +
    `===================\n` +
    `${error.stdout || ''}\n` +
    `${error.stderr || ''}\n` +
    `${error.message}\n\n` +
    `Even though an error occurred, this might represent the actual breaking point.\n` +
    `Examine the logs to determine the last successful configuration.\n\n` +
    `Test failed at: ${new Date().toISOString()}\n`
  );
}

/**
 * Check if a breaking point is reached based on metrics and threshold level
 */
export function isBreakingPoint(metrics: LoadTestMetrics, thresholdLevel: ThresholdLevel): boolean {
  const thresholds = THRESHOLD_CONFIGS[thresholdLevel];

  const errorRate = (metrics.errorCount / metrics.messagesSent) * 100;

  return (
    errorRate > thresholds.errorRateThreshold ||
    metrics.avgResponseTime > thresholds.responseTimeThreshold ||
    metrics.successRate < thresholds.successRateThreshold ||
    metrics.peakMemoryUsage > thresholds.memoryThreshold
  );
}

/**
 * Format detailed metrics for a log file
 */
export function formatDetailedMetrics(config: ScaleConfig, metrics: LoadTestMetrics): string {
  let output = '\n========== DETAILED METRICS ==========\n';
  output += `Configuration: ${config.description}\n`;
  output += `Agents: ${config.agents}\n`;
  output += `Messages: ${config.messageCount}\n`;
  output += `Test Duration: ${(metrics.totalTime / 1000).toFixed(2)} seconds\n\n`;

  output += 'PERFORMANCE METRICS:\n';
  output += `- Messages Sent: ${metrics.messagesSent}\n`;
  output += `- Messages Processed: ${metrics.messagesProcessed}\n`;
  output += `- Success Rate: ${metrics.successRate.toFixed(2)}%\n`;
  output += `- Throughput: ${metrics.throughput.toFixed(2)} messages/second\n\n`;

  output += 'RESPONSE TIME METRICS:\n';
  output += `- Average Response Time: ${metrics.avgResponseTime.toFixed(2)}ms\n`;
  output += `- Minimum Response Time: ${metrics.minResponseTime}ms\n`;
  output += `- Maximum Response Time: ${metrics.maxResponseTime}ms\n\n`;

  output += 'ERROR METRICS:\n';
  output += `- Total Errors: ${metrics.errorCount}\n`;
  output += `- Timeout Count: ${metrics.timeoutCount}\n`;

  if (Object.keys(metrics.errorTypes).length > 0) {
    output += '- Error Types:\n';
    for (const [type, count] of Object.entries(metrics.errorTypes)) {
      output += `  * ${type}: ${count}\n`;
    }
  }

  output += '\nSYSTEM RESOURCE METRICS:\n';
  output += `- Memory Usage: ${metrics.memoryUsageStart.toFixed(2)}MB → ${metrics.memoryUsageEnd.toFixed(2)}MB\n`;
  output += `- Peak Memory Usage: ${metrics.peakMemoryUsage.toFixed(2)}MB\n`;
  output += '===================================\n';

  return output;
}

/**
 * Format a summary log line
 */
export function formatSummaryLogLine(config: ScaleConfig, metrics: LoadTestMetrics): string {
  return (
    `${config.description.padEnd(13)} | ${String(config.agents).padEnd(6)} | ` +
    `${String(config.messageCount).padEnd(8)} | ` +
    `${metrics.successRate.toFixed(2)}% | ` +
    `${metrics.avgResponseTime.toFixed(2)}ms | ` +
    `${metrics.peakMemoryUsage.toFixed(2)}MB | ` +
    `${metrics.throughput.toFixed(2)}/s | ` +
    `${metrics.errorCount}\n`
  );
}

// Export all functions for both TS and JS usage
export default {
  ThresholdLevel,
  THRESHOLD_CONFIGS,
  ensureLogsDirectory,
  generateTimestamp,
  createScalabilityAnalysisHeader,
  createLoadTestSummaryHeader,
  createDetailedTestLogHeader,
  formatBreakingPointNotification,
  formatScalabilityConclusions,
  formatVisualizationGuide,
  formatErrorMessage,
  isBreakingPoint,
  formatDetailedMetrics,
  formatSummaryLogLine,
};
