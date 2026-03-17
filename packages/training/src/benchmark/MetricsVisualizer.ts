/**
 * Metrics Visualizer
 *
 * Generates visualizations and reports from benchmark results:
 * - P&L over time charts
 * - Prediction accuracy graphs
 * - Social metrics
 * - Comparison tables
 * - Performance scorecards
 * - Head-to-Head Baseline vs Challenger reports
 *
 * Outputs HTML reports, JSON data, and ASCII terminal charts for analysis.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { logger } from "../utils/logger";
import type { BenchmarkComparisonResult } from "./BenchmarkRunner";
import type { SimulationResult } from "./SimulationEngine";

export interface VisualizationConfig {
  /** Output directory for visualizations */
  outputDir: string;

  /** Generate HTML report */
  generateHtml: boolean;

  /** Generate CSV exports */
  generateCsv: boolean;

  /** Generate charts (requires chart library) */
  generateCharts: boolean;
}

export class MetricsVisualizer {
  /**
   * Generate complete visualization suite for a single run
   */
  static async visualizeSingleRun(
    result: SimulationResult,
    config: VisualizationConfig,
  ): Promise<void> {
    logger.info("Generating visualizations", { resultId: result.id });

    await fs.mkdir(config.outputDir, { recursive: true });

    // 1. Generate metrics summary
    const summaryHtml = MetricsVisualizer.generateMetricsSummary(result);
    await fs.writeFile(
      path.join(config.outputDir, "summary.html"),
      summaryHtml,
    );

    // 2. Generate detailed metrics tables
    const detailedHtml = MetricsVisualizer.generateDetailedMetrics(result);
    await fs.writeFile(
      path.join(config.outputDir, "detailed.html"),
      detailedHtml,
    );

    // 3. Generate action timeline
    const timelineHtml = MetricsVisualizer.generateActionTimeline(result);
    await fs.writeFile(
      path.join(config.outputDir, "timeline.html"),
      timelineHtml,
    );

    // 4. Generate CSV exports if requested
    if (config.generateCsv) {
      await MetricsVisualizer.exportToCsv(result, config.outputDir);
    }

    // 5. Generate master report that links everything
    const reportHtml = MetricsVisualizer.generateMasterReport(result);
    await fs.writeFile(path.join(config.outputDir, "index.html"), reportHtml);

    logger.info("Visualizations generated", { outputDir: config.outputDir });
  }

  /**
   * Generate comparison visualization for multiple runs (Batch Mode)
   */
  static async visualizeComparison(
    comparison: BenchmarkComparisonResult,
    config: VisualizationConfig,
  ): Promise<void> {
    logger.info("Generating comparison visualizations");

    await fs.mkdir(config.outputDir, { recursive: true });

    // 1. Generate comparison summary
    const summaryHtml = MetricsVisualizer.generateComparisonSummary(comparison);
    await fs.writeFile(
      path.join(config.outputDir, "comparison.html"),
      summaryHtml,
    );

    // 2. Generate performance distribution charts
    const distributionHtml =
      MetricsVisualizer.generateDistributionCharts(comparison);
    await fs.writeFile(
      path.join(config.outputDir, "distribution.html"),
      distributionHtml,
    );

    // 3. Export comparison data to CSV
    if (config.generateCsv) {
      await MetricsVisualizer.exportComparisonToCsv(
        comparison,
        config.outputDir,
      );
    }

    logger.info("Comparison visualizations generated");
  }

  /**
   * Generate Head-to-Head Comparison Report (Baseline vs Challenger)
   * Includes ASCII chart for terminal output and JSON/Text reports.
   */
  static async generateComparisonReport(
    baseline: SimulationResult,
    challenger: SimulationResult,
    outputDir: string,
  ): Promise<void> {
    logger.info("Generating head-to-head comparison report...");
    await fs.mkdir(outputDir, { recursive: true });

    // 1. Generate ASCII Chart and print to terminal
    const asciiReport = MetricsVisualizer.generateAsciiComparison(
      baseline,
      challenger,
    );
    console.log(asciiReport);

    // 2. Save JSON Report with full data
    const jsonReport = {
      timestamp: new Date().toISOString(),
      benchmarkId: baseline.benchmarkId,
      baseline: {
        agentId: baseline.agentId,
        pnl: baseline.metrics.totalPnl,
        accuracy: baseline.metrics.predictionMetrics.accuracy,
        winRate: baseline.metrics.perpMetrics.winRate,
        optimality: baseline.metrics.optimalityScore,
      },
      challenger: {
        agentId: challenger.agentId,
        pnl: challenger.metrics.totalPnl,
        accuracy: challenger.metrics.predictionMetrics.accuracy,
        winRate: challenger.metrics.perpMetrics.winRate,
        optimality: challenger.metrics.optimalityScore,
      },
      delta: {
        pnl: challenger.metrics.totalPnl - baseline.metrics.totalPnl,
        accuracy:
          challenger.metrics.predictionMetrics.accuracy -
          baseline.metrics.predictionMetrics.accuracy,
        winRate:
          challenger.metrics.perpMetrics.winRate -
          baseline.metrics.perpMetrics.winRate,
      },
      pnlHistory: MetricsVisualizer.mergePnlHistory(baseline, challenger),
    };

    await fs.writeFile(
      path.join(outputDir, "comparison.json"),
      JSON.stringify(jsonReport, null, 2),
    );

    // 3. Save Text Report (ASCII chart)
    await fs.writeFile(path.join(outputDir, "report.txt"), asciiReport);

    logger.info(`Comparison report saved to ${outputDir}`);
  }

  /**
   * Generate ASCII Comparison Chart for Terminal
   * Public for testing purposes
   */
  static generateAsciiComparison(
    baseline: SimulationResult,
    challenger: SimulationResult,
  ): string {
    const pnlDelta = challenger.metrics.totalPnl - baseline.metrics.totalPnl;
    const winner = pnlDelta >= 0 ? "Challenger (LLM)" : "Baseline";

    let output = `
=== 🥊 HEAD-TO-HEAD RESULTS ===
Benchmark: ${baseline.benchmarkId}
Baseline: ${baseline.agentId} | Challenger: ${challenger.agentId}

💰 Cumulative PnL:
Tick  | Baseline               | Challenger             | Delta
----------------------------------------------------------------------
`;

    // Sample points (every 10th tick or so to fit terminal vertically)
    const history = MetricsVisualizer.mergePnlHistory(baseline, challenger);
    const step = Math.max(1, Math.floor(history.length / 10));

    for (let i = 0; i < history.length; i += step) {
      const point = history[i];
      if (!point) continue; // Skip if point is somehow undefined

      const basePnl = point.baseline.toFixed(0);
      const chalPnl = point.challenger.toFixed(0);
      const deltaVal = point.challenger - point.baseline;
      const deltaStr = deltaVal.toFixed(0);
      const sign = deltaVal >= 0 ? "+" : "";

      // Format columns nicely
      output += `${point.tick.toString().padEnd(5)} | $${basePnl.padEnd(
        21,
      )} | $${chalPnl.padEnd(21)} | ${sign}$${deltaStr}\n`;
    }

    // Final result row
    const finalBase = baseline.metrics.totalPnl.toFixed(2);
    const finalChal = challenger.metrics.totalPnl.toFixed(2);
    const finalDelta = pnlDelta.toFixed(2);
    const finalSign = pnlDelta >= 0 ? "+" : "";

    output += `
----------------------------------------------------------------------
FINAL | $${finalBase.padEnd(21)} | $${finalChal.padEnd(
      21,
    )} | ${finalSign}$${finalDelta}

🏆 WINNER: ${winner}
🚀 Alpha Generated: ${finalSign}$${finalDelta}
`;

    return output;
  }

  /**
   * Merge PnL histories from two runs into a single timeline
   * Public for testing purposes
   */
  static mergePnlHistory(
    baseline: SimulationResult,
    challenger: SimulationResult,
  ): Array<{ tick: number; baseline: number; challenger: number }> {
    const merged = [];
    const maxTicks = Math.max(
      baseline.pnlHistory?.length || 0,
      challenger.pnlHistory?.length || 0,
    );

    for (let i = 0; i < maxTicks; i++) {
      // Use optional chaining and default to final PnL if history is missing or shorter
      // pnlHistory[i] might be undefined if one run is shorter than the other
      const baseTick = baseline.pnlHistory?.[i];
      const chalTick = challenger.pnlHistory?.[i];

      const basePnl = baseTick ? baseTick.pnl : baseline.metrics.totalPnl;
      const chalPnl = chalTick ? chalTick.pnl : challenger.metrics.totalPnl;

      merged.push({
        tick: i,
        baseline: basePnl,
        challenger: chalPnl,
      });
    }
    return merged;
  }

  // =========================================================================
  // Existing Single-Run and Batch Visualizations
  // =========================================================================

  /**
   * Generate metrics summary card
   */
  private static generateMetricsSummary(result: SimulationResult): string {
    const { metrics } = result;

    return `
<!DOCTYPE html>
<html>
<head>
  <title>Benchmark Metrics Summary</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 1200px;
      margin: 40px auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .card {
      background: white;
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .metric {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }
    .metric-group {
      background: #f9f9f9;
      padding: 16px;
      border-radius: 6px;
    }
    .metric-group h3 {
      margin-top: 0;
      color: #333;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .metric-item {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #eee;
    }
    .metric-item:last-child {
      border-bottom: none;
    }
    .metric-label {
      color: #666;
      font-size: 14px;
    }
    .metric-value {
      font-weight: 600;
      font-size: 16px;
      color: #333;
    }
    .metric-value.positive {
      color: #10b981;
    }
    .metric-value.negative {
      color: #ef4444;
    }
    .score-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .score-excellent { background: #d1fae5; color: #065f46; }
    .score-good { background: #dbeafe; color: #1e40af; }
    .score-fair { background: #fef3c7; color: #92400e; }
    .score-poor { background: #fee2e2; color: #991b1b; }
    h1 {
      color: #111;
      margin-bottom: 8px;
    }
    .subtitle {
      color: #666;
      margin-bottom: 32px;
    }
  </style>
</head>
<body>
  <h1>📊 Benchmark Results</h1>
  <p class="subtitle">Agent: ${result.agentId} | Benchmark: ${result.benchmarkId}</p>
  
  <div class="card">
    <h2>Overall Performance</h2>
    <div class="metric-item">
      <span class="metric-label">Total P&L</span>
      <span class="metric-value ${metrics.totalPnl >= 0 ? "positive" : "negative"}">
        ${metrics.totalPnl >= 0 ? "+" : ""}$${metrics.totalPnl.toFixed(2)}
      </span>
    </div>
    <div class="metric-item">
      <span class="metric-label">Optimality Score</span>
      <span class="metric-value">
        ${metrics.optimalityScore.toFixed(1)}%
        ${MetricsVisualizer.getScoreBadge(metrics.optimalityScore)}
      </span>
    </div>
    <div class="metric-item">
      <span class="metric-label">Total Duration</span>
      <span class="metric-value">${(metrics.timing.totalDuration / 1000).toFixed(1)}s</span>
    </div>
    <div class="metric-item">
      <span class="metric-label">Avg Response Time</span>
      <span class="metric-value">${metrics.timing.avgResponseTime.toFixed(0)}ms</span>
    </div>
  </div>
  
  <div class="card">
    <div class="metric">
      <div class="metric-group">
        <h3>Prediction Markets</h3>
        <div class="metric-item">
          <span class="metric-label">Total Positions</span>
          <span class="metric-value">${metrics.predictionMetrics.totalPositions}</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Accuracy</span>
          <span class="metric-value ${metrics.predictionMetrics.accuracy >= 0.6 ? "positive" : ""}">${(metrics.predictionMetrics.accuracy * 100).toFixed(1)}%</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Correct</span>
          <span class="metric-value positive">${metrics.predictionMetrics.correctPredictions}</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Incorrect</span>
          <span class="metric-value negative">${metrics.predictionMetrics.incorrectPredictions}</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Avg P&L per Position</span>
          <span class="metric-value ${metrics.predictionMetrics.avgPnlPerPosition >= 0 ? "positive" : "negative"}">
            ${metrics.predictionMetrics.avgPnlPerPosition >= 0 ? "+" : ""}$${metrics.predictionMetrics.avgPnlPerPosition.toFixed(2)}
          </span>
        </div>
      </div>
      
      <div class="metric-group">
        <h3>Perpetual Futures</h3>
        <div class="metric-item">
          <span class="metric-label">Total Trades</span>
          <span class="metric-value">${metrics.perpMetrics.totalTrades}</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Win Rate</span>
          <span class="metric-value ${metrics.perpMetrics.winRate >= 0.5 ? "positive" : ""}">${(metrics.perpMetrics.winRate * 100).toFixed(1)}%</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Profitable Trades</span>
          <span class="metric-value positive">${metrics.perpMetrics.profitableTrades}</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Avg P&L per Trade</span>
          <span class="metric-value ${metrics.perpMetrics.avgPnlPerTrade >= 0 ? "positive" : "negative"}">
            ${metrics.perpMetrics.avgPnlPerTrade >= 0 ? "+" : ""}$${metrics.perpMetrics.avgPnlPerTrade.toFixed(2)}
          </span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Max Drawdown</span>
          <span class="metric-value negative">$${metrics.perpMetrics.maxDrawdown.toFixed(2)}</span>
        </div>
      </div>
    </div>
  </div>
  
  <div class="card">
    <h2>Social Engagement</h2>
    <div class="metric-item">
      <span class="metric-label">Posts Created</span>
      <span class="metric-value">${metrics.socialMetrics.postsCreated}</span>
    </div>
    <div class="metric-item">
      <span class="metric-label">Groups Joined</span>
      <span class="metric-value">${metrics.socialMetrics.groupsJoined}</span>
    </div>
    <div class="metric-item">
      <span class="metric-label">Reputation Gained</span>
      <span class="metric-value ${metrics.socialMetrics.reputationGained >= 0 ? "positive" : "negative"}">
        ${metrics.socialMetrics.reputationGained >= 0 ? "+" : ""}${metrics.socialMetrics.reputationGained}
      </span>
    </div>
  </div>
  
  <p style="text-align: center; color: #999; margin-top: 40px;">
    Generated: ${new Date().toLocaleString()}
  </p>
</body>
</html>`;
  }

  /**
   * Generate detailed metrics tables
   */
  private static generateDetailedMetrics(result: SimulationResult): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <title>Detailed Metrics</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 1400px;
      margin: 40px auto;
      padding: 20px;
      background: #f5f5f5;
    }
    table {
      width: 100%;
      background: white;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      margin-bottom: 20px;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #eee;
    }
    th {
      background: #f9f9f9;
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #666;
    }
    tr:last-child td {
      border-bottom: none;
    }
    .positive { color: #10b981; }
    .negative { color: #ef4444; }
  </style>
</head>
<body>
  <h1>Detailed Action Log</h1>
  
  <table>
    <thead>
      <tr>
        <th>Tick</th>
        <th>Type</th>
        <th>Details</th>
        <th>Duration</th>
      </tr>
    </thead>
    <tbody>
      ${result.actions
        .map(
          (action) => `
        <tr>
          <td>#${action.tick}</td>
          <td>${action.type}</td>
          <td><code>${JSON.stringify(action.data)}</code></td>
          <td>${action.duration}ms</td>
        </tr>
      `,
        )
        .join("")}
    </tbody>
  </table>
</body>
</html>`;
  }

  /**
   * Generate action timeline
   */
  private static generateActionTimeline(result: SimulationResult): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <title>Action Timeline</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 1200px;
      margin: 40px auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .timeline {
      position: relative;
      padding: 20px 0;
    }
    .timeline-item {
      background: white;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 12px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      position: relative;
      padding-left: 80px;
    }
    .timeline-item::before {
      content: '#' attr(data-tick);
      position: absolute;
      left: 16px;
      top: 16px;
      font-weight: 600;
      color: #666;
      font-size: 14px;
    }
    .action-type {
      font-weight: 600;
      color: #333;
      margin-bottom: 4px;
    }
    .action-details {
      color: #666;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <h1>Action Timeline</h1>
  <div class="timeline">
    ${result.actions
      .map(
        (action) => `
      <div class="timeline-item" data-tick="${action.tick}">
        <div class="action-type">${action.type}</div>
        <div class="action-details">${JSON.stringify(action.data)}</div>
      </div>
    `,
      )
      .join("")}
  </div>
</body>
</html>`;
  }

  /**
   * Generate master report
   */
  private static generateMasterReport(result: SimulationResult): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <title>Benchmark Report</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 800px;
      margin: 40px auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .nav {
      background: white;
      border-radius: 8px;
      padding: 24px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .nav a {
      display: block;
      padding: 12px 16px;
      color: #333;
      text-decoration: none;
      border-radius: 6px;
      margin-bottom: 8px;
      transition: background 0.2s;
    }
    .nav a:hover {
      background: #f9f9f9;
    }
    h1 {
      color: #111;
    }
  </style>
</head>
<body>
  <h1>📊 Benchmark Report</h1>
  <p>Agent: <strong>${result.agentId}</strong></p>
  <p>Benchmark: <strong>${result.benchmarkId}</strong></p>
  <p>Date: ${new Date(result.startTime).toLocaleString()}</p>
  
  <div class="nav">
    <h2>Reports</h2>
    <a href="summary.html">📈 Summary</a>
    <a href="detailed.html">📋 Detailed Metrics</a>
    <a href="timeline.html">⏱️ Action Timeline</a>
  </div>
</body>
</html>`;
  }

  /**
   * Generate comparison summary
   */
  private static generateComparisonSummary(
    comparison: BenchmarkComparisonResult,
  ): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <title>Benchmark Comparison</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 1200px;
      margin: 40px auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .card {
      background: white;
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #eee;
    }
    th {
      background: #f9f9f9;
      font-weight: 600;
    }
    .positive { color: #10b981; }
    .negative { color: #ef4444; }
  </style>
</head>
<body>
  <h1>Benchmark Comparison (${comparison.runs.length} runs)</h1>
  
  <div class="card">
    <h2>Summary Statistics</h2>
    <table>
      <tr>
        <th>Metric</th>
        <th>Average</th>
        <th>Best</th>
        <th>Worst</th>
      </tr>
      <tr>
        <td>P&L</td>
        <td class="${comparison.comparison.avgPnl >= 0 ? "positive" : "negative"}">$${comparison.comparison.avgPnl.toFixed(2)}</td>
        <td>${comparison.comparison.bestRun}</td>
        <td>${comparison.comparison.worstRun}</td>
      </tr>
      <tr>
        <td>Accuracy</td>
        <td>${(comparison.comparison.avgAccuracy * 100).toFixed(1)}%</td>
        <td>-</td>
        <td>-</td>
      </tr>
      <tr>
        <td>Optimality</td>
        <td>${comparison.comparison.avgOptimality.toFixed(1)}%</td>
        <td>-</td>
        <td>-</td>
      </tr>
    </table>
  </div>
  
  <div class="card">
    <h2>Individual Runs</h2>
    <table>
      <thead>
        <tr>
          <th>Run</th>
          <th>Total P&L</th>
          <th>Accuracy</th>
          <th>Optimality</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        ${comparison.runs
          .map(
            (run, i) => `
          <tr>
            <td>Run ${i + 1}</td>
            <td class="${run.metrics.totalPnl >= 0 ? "positive" : "negative"}">$${run.metrics.totalPnl.toFixed(2)}</td>
            <td>${(run.metrics.predictionMetrics.accuracy * 100).toFixed(1)}%</td>
            <td>${run.metrics.optimalityScore.toFixed(1)}%</td>
            <td>${(run.metrics.timing.totalDuration / 1000).toFixed(1)}s</td>
          </tr>
        `,
          )
          .join("")}
      </tbody>
    </table>
  </div>
</body>
</html>`;
  }

  /**
   * Generate distribution charts
   */
  private static generateDistributionCharts(
    comparison: BenchmarkComparisonResult,
  ): string {
    const pnls = comparison.runs.map((r) => r.metrics.totalPnl);
    const accuracies = comparison.runs.map(
      (r) => r.metrics.predictionMetrics.accuracy * 100,
    );

    return `
<!DOCTYPE html>
<html>
<head>
  <title>Performance Distribution</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 1200px;
      margin: 40px auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .chart {
      background: white;
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .bar {
      height: 30px;
      background: #3b82f6;
      border-radius: 4px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      padding: 0 12px;
      color: white;
      font-size: 14px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <h1>Performance Distribution</h1>
  
  <div class="chart">
    <h2>P&L Distribution</h2>
    ${pnls
      .map(
        (pnl, i) => `
      <div class="bar" style="width: ${(Math.abs(pnl) / Math.max(...pnls.map(Math.abs))) * 100}%">
        Run ${i + 1}: $${pnl.toFixed(2)}
      </div>
    `,
      )
      .join("")}
  </div>
  
  <div class="chart">
    <h2>Accuracy Distribution</h2>
    ${accuracies
      .map(
        (acc, i) => `
      <div class="bar" style="width: ${acc}%">
        Run ${i + 1}: ${acc.toFixed(1)}%
      </div>
    `,
      )
      .join("")}
  </div>
</body>
</html>`;
  }

  /**
   * Export to CSV
   */
  private static async exportToCsv(
    result: SimulationResult,
    outputDir: string,
  ): Promise<void> {
    // Actions CSV
    const actionsCsv = [
      "tick,type,data,duration",
      ...result.actions.map(
        (a) =>
          `${a.tick},"${a.type}","${JSON.stringify(a.data).replace(/"/g, '""')}",${a.duration}`,
      ),
    ].join("\n");

    await fs.writeFile(path.join(outputDir, "actions.csv"), actionsCsv);

    // Metrics CSV
    const metricsCsv = [
      "metric,value",
      `total_pnl,${result.metrics.totalPnl}`,
      `prediction_accuracy,${result.metrics.predictionMetrics.accuracy}`,
      `perp_win_rate,${result.metrics.perpMetrics.winRate}`,
      `optimality_score,${result.metrics.optimalityScore}`,
      `avg_response_time,${result.metrics.timing.avgResponseTime}`,
    ].join("\n");

    await fs.writeFile(path.join(outputDir, "metrics.csv"), metricsCsv);
  }

  /**
   * Export comparison to CSV
   */
  private static async exportComparisonToCsv(
    comparison: BenchmarkComparisonResult,
    outputDir: string,
  ): Promise<void> {
    const csv = [
      "run,total_pnl,accuracy,optimality,duration",
      ...comparison.runs.map(
        (run, i) =>
          `${i + 1},${run.metrics.totalPnl},${run.metrics.predictionMetrics.accuracy},${run.metrics.optimalityScore},${run.metrics.timing.totalDuration}`,
      ),
    ].join("\n");

    await fs.writeFile(path.join(outputDir, "comparison.csv"), csv);
  }

  /**
   * Get score badge HTML
   */
  private static getScoreBadge(score: number): string {
    if (score >= 80)
      return '<span class="score-badge score-excellent">Excellent</span>';
    if (score >= 60) return '<span class="score-badge score-good">Good</span>';
    if (score >= 40) return '<span class="score-badge score-fair">Fair</span>';
    return '<span class="score-badge score-poor">Poor</span>';
  }
}
