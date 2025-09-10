/**
 * Performance metrics calculation utilities
 */

import { TestResult, PerformanceMetrics } from "./types";

/**
 * Calculate percentile from sorted array
 */
function calculatePercentile(sortedArray: number[], percentile: number): number {
  if (sortedArray.length === 0) return 0;
  
  const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
  return sortedArray[Math.max(0, index)];
}

/**
 * Calculate standard deviation
 */
function calculateStdDev(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  
  const squaredDiffs = values.map(value => Math.pow(value - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((sum, diff) => sum + diff, 0) / values.length;
  return Math.sqrt(avgSquaredDiff);
}

/**
 * Calculate performance metrics from test results
 */
export function calculateMetrics(
  results: TestResult[],
  category: string
): PerformanceMetrics {
  const successfulResults = results.filter(r => r.success);
  const responseTimes = successfulResults.map(r => r.responseTime).sort((a, b) => a - b);
  
  const totalTests = results.length;
  const successfulTests = successfulResults.length;
  const failedTests = totalTests - successfulTests;
  
  // Calculate metrics
  const mean = responseTimes.length > 0
    ? responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length
    : 0;
  
  return {
    category,
    totalTests,
    successfulTests,
    failedTests,
    p50: calculatePercentile(responseTimes, 50),
    p95: calculatePercentile(responseTimes, 95),
    p99: calculatePercentile(responseTimes, 99),
    mean,
    min: responseTimes.length > 0 ? responseTimes[0] : 0,
    max: responseTimes.length > 0 ? responseTimes[responseTimes.length - 1] : 0,
    stdDev: calculateStdDev(responseTimes, mean),
  };
}

/**
 * Format metrics for display
 */
export function formatMetrics(metrics: PerformanceMetrics): string {
  const successRate = (metrics.successfulTests / metrics.totalTests * 100).toFixed(1);
  
  return `
╔════════════════════════════════════════════════════════════╗
║ Performance Metrics: ${metrics.category.padEnd(37)}║
╠════════════════════════════════════════════════════════════╣
║ Total Tests:     ${String(metrics.totalTests).padEnd(42)}║
║ Successful:      ${String(metrics.successfulTests).padEnd(42)}║
║ Failed:          ${String(metrics.failedTests).padEnd(42)}║
║ Success Rate:    ${(successRate + "%").padEnd(42)}║
╠════════════════════════════════════════════════════════════╣
║ Response Times (ms):                                       ║
║   P50 (median):  ${String(metrics.p50.toFixed(2)).padEnd(42)}║
║   P95:           ${String(metrics.p95.toFixed(2)).padEnd(42)}║
║   P99:           ${String(metrics.p99.toFixed(2)).padEnd(42)}║
║   Mean:          ${String(metrics.mean.toFixed(2)).padEnd(42)}║
║   Min:           ${String(metrics.min.toFixed(2)).padEnd(42)}║
║   Max:           ${String(metrics.max.toFixed(2)).padEnd(42)}║
║   Std Dev:       ${String(metrics.stdDev.toFixed(2)).padEnd(42)}║
╚════════════════════════════════════════════════════════════╝
`;
}

/**
 * Generate histogram of response times
 */
export function generateHistogram(
  responseTimes: number[],
  buckets: number = 10
): string {
  if (responseTimes.length === 0) return "No data available";
  
  const sorted = [...responseTimes].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const range = max - min;
  const bucketSize = range / buckets;
  
  // Create buckets
  const histogram: number[] = new Array(buckets).fill(0);
  
  sorted.forEach(time => {
    const bucketIndex = Math.min(
      Math.floor((time - min) / bucketSize),
      buckets - 1
    );
    histogram[bucketIndex]++;
  });
  
  // Find max count for scaling
  const maxCount = Math.max(...histogram);
  const barWidth = 40;
  
  let output = "\nResponse Time Distribution:\n";
  output += "─".repeat(60) + "\n";
  
  for (let i = 0; i < buckets; i++) {
    const rangeStart = min + (i * bucketSize);
    const rangeEnd = min + ((i + 1) * bucketSize);
    const count = histogram[i];
    const barLength = Math.round((count / maxCount) * barWidth);
    const bar = "█".repeat(barLength) + "░".repeat(barWidth - barLength);
    
    output += `${rangeStart.toFixed(0).padStart(5)}-${rangeEnd.toFixed(0).padEnd(5)} ms │ ${bar} │ ${count}\n`;
  }
  
  return output;
}

/**
 * Compare metrics against thresholds
 */
export function checkThresholds(
  metrics: PerformanceMetrics,
  thresholds: {
    p50?: number;
    p95?: number;
    p99?: number;
    successRate?: number;
  }
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  
  if (thresholds.p50 !== undefined && metrics.p50 > thresholds.p50) {
    failures.push(`P50 (${metrics.p50.toFixed(2)}ms) exceeds threshold (${thresholds.p50}ms)`);
  }
  
  if (thresholds.p95 !== undefined && metrics.p95 > thresholds.p95) {
    failures.push(`P95 (${metrics.p95.toFixed(2)}ms) exceeds threshold (${thresholds.p95}ms)`);
  }
  
  if (thresholds.p99 !== undefined && metrics.p99 > thresholds.p99) {
    failures.push(`P99 (${metrics.p99.toFixed(2)}ms) exceeds threshold (${thresholds.p99}ms)`);
  }
  
  if (thresholds.successRate !== undefined) {
    const actualRate = metrics.successfulTests / metrics.totalTests;
    if (actualRate < thresholds.successRate) {
      failures.push(
        `Success rate (${(actualRate * 100).toFixed(1)}%) below threshold (${(thresholds.successRate * 100).toFixed(1)}%)`
      );
    }
  }
  
  return {
    passed: failures.length === 0,
    failures,
  };
}

/**
 * Generate summary report for all categories
 */
export function generateSummaryReport(
  allMetrics: PerformanceMetrics[]
): string {
  let report = "\n" + "=".repeat(60) + "\n";
  report += "BENCHMARK SUMMARY REPORT\n";
  report += "=".repeat(60) + "\n";
  
  allMetrics.forEach(metrics => {
    report += formatMetrics(metrics);
    report += "\n";
  });
  
  // Overall statistics
  const totalTests = allMetrics.reduce((sum, m) => sum + m.totalTests, 0);
  const totalSuccess = allMetrics.reduce((sum, m) => sum + m.successfulTests, 0);
  const overallSuccessRate = (totalSuccess / totalTests * 100).toFixed(1);
  
  report += "\n" + "─".repeat(60) + "\n";
  report += "OVERALL STATISTICS\n";
  report += "─".repeat(60) + "\n";
  report += `Total Tests Run:     ${totalTests}\n`;
  report += `Total Successful:    ${totalSuccess}\n`;
  report += `Overall Success Rate: ${overallSuccessRate}%\n`;
  report += "=".repeat(60) + "\n";
  
  return report;
}
