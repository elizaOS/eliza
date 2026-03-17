/**
 * Benchmark Chart Generator
 *
 * Generates charts and visualizations for benchmark results.
 * Creates interactive HTML reports with embedded charts.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { SimulationMetrics } from "./SimulationEngine";

export interface ChartData {
  labels: string[];
  datasets: ChartDataset[];
}

export interface ChartDataset {
  label: string;
  data: number[];
  backgroundColor?: string;
  borderColor?: string;
}

export interface ModelComparisonData {
  modelId: string;
  modelName: string;
  metrics: SimulationMetrics;
  runAt: Date;
}

export interface BenchmarkHistoryEntry {
  runId: string;
  modelId: string;
  modelName: string;
  benchmarkId: string;
  metrics: SimulationMetrics;
  runAt: Date;
}

/**
 * Color palette for charts
 */
const CHART_COLORS = {
  primary: "#3b82f6",
  success: "#10b981",
  warning: "#f59e0b",
  danger: "#ef4444",
  purple: "#8b5cf6",
  cyan: "#06b6d4",
  pink: "#ec4899",
  gray: "#6b7280",
};

/**
 * Generates benchmark charts and reports
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Chart generator namespace - methods are logically grouped
export class BenchmarkChartGenerator {
  /**
   * Generate a comprehensive HTML report with charts
   */
  static async generateReport(
    results: ModelComparisonData[],
    outputPath: string,
    options: {
      title?: string;
      benchmarkId?: string;
      includeHistory?: BenchmarkHistoryEntry[];
    } = {},
  ): Promise<string> {
    const title = options.title ?? "Benchmark Report";
    const benchmarkId = options.benchmarkId ?? "unknown";

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg-primary: #0f172a;
      --bg-secondary: #1e293b;
      --bg-tertiary: #334155;
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --accent-primary: #3b82f6;
      --accent-success: #10b981;
      --accent-warning: #f59e0b;
      --accent-danger: #ef4444;
      --border-color: #475569;
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      padding: 2rem;
    }
    
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    
    header {
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border-color);
    }
    
    h1 {
      font-size: 2rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, var(--accent-primary), var(--accent-success));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    
    .subtitle {
      color: var(--text-secondary);
      font-size: 1rem;
    }
    
    .grid {
      display: grid;
      gap: 1.5rem;
    }
    
    .grid-2 {
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
    }
    
    .grid-3 {
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    }
    
    .card {
      background: var(--bg-secondary);
      border-radius: 16px;
      padding: 1.5rem;
      border: 1px solid var(--border-color);
    }
    
    .card-title {
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: var(--text-primary);
    }
    
    .chart-container {
      position: relative;
      height: 300px;
    }
    
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
    }
    
    .stat-card {
      background: var(--bg-tertiary);
      border-radius: 12px;
      padding: 1rem;
      text-align: center;
    }
    
    .stat-value {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 0.25rem;
    }
    
    .stat-value.positive {
      color: var(--accent-success);
    }
    
    .stat-value.negative {
      color: var(--accent-danger);
    }
    
    .stat-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    
    th, td {
      padding: 0.75rem 1rem;
      text-align: left;
      border-bottom: 1px solid var(--border-color);
    }
    
    th {
      font-weight: 600;
      color: var(--text-secondary);
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    tr:hover {
      background: var(--bg-tertiary);
    }
    
    .badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    
    .badge-success {
      background: rgba(16, 185, 129, 0.2);
      color: var(--accent-success);
    }
    
    .badge-warning {
      background: rgba(245, 158, 11, 0.2);
      color: var(--accent-warning);
    }
    
    .badge-danger {
      background: rgba(239, 68, 68, 0.2);
      color: var(--accent-danger);
    }
    
    .winner-tag {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      background: linear-gradient(135deg, #fbbf24, #f59e0b);
      color: #1f2937;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-size: 0.625rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    
    .timestamp {
      color: var(--text-secondary);
      font-size: 0.875rem;
      margin-top: 2rem;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📊 ${title}</h1>
      <p class="subtitle">Benchmark: ${benchmarkId} | Models: ${results.length}</p>
    </header>
    
    ${BenchmarkChartGenerator.generateSummaryStats(results)}
    
    <div class="grid grid-2" style="margin-top: 1.5rem;">
      ${BenchmarkChartGenerator.generatePnLChartCard()}
      ${BenchmarkChartGenerator.generateAccuracyChartCard()}
    </div>
    
    <div class="grid grid-2" style="margin-top: 1.5rem;">
      ${BenchmarkChartGenerator.generatePerpMetricsChartCard()}
      ${BenchmarkChartGenerator.generateTimingChartCard()}
    </div>
    
    ${BenchmarkChartGenerator.generateComparisonTable(results)}
    
    ${options.includeHistory ? BenchmarkChartGenerator.generateHistorySection(options.includeHistory) : ""}
    
    <p class="timestamp">Generated: ${new Date().toLocaleString()}</p>
  </div>
  
  <script>
    Chart.defaults.color = '#94a3b8';
    Chart.defaults.borderColor = '#475569';
    
    ${BenchmarkChartGenerator.generateChartScripts(results)}
  </script>
</body>
</html>`;

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, html, "utf-8");

    return outputPath;
  }

  /**
   * Generate summary stats section
   */
  private static generateSummaryStats(results: ModelComparisonData[]): string {
    if (results.length === 0) return "";

    // Find best model for each metric
    const bestPnl = results.reduce((best, curr) =>
      curr.metrics.totalPnl > best.metrics.totalPnl ? curr : best,
    );
    const bestAccuracy = results.reduce((best, curr) =>
      curr.metrics.predictionMetrics.accuracy >
      best.metrics.predictionMetrics.accuracy
        ? curr
        : best,
    );
    const avgPnl =
      results.reduce((sum, r) => sum + r.metrics.totalPnl, 0) / results.length;
    const avgAccuracy =
      results.reduce(
        (sum, r) => sum + r.metrics.predictionMetrics.accuracy,
        0,
      ) / results.length;

    return `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value ${bestPnl.metrics.totalPnl >= 0 ? "positive" : "negative"}">
          ${bestPnl.metrics.totalPnl >= 0 ? "+" : ""}$${bestPnl.metrics.totalPnl.toFixed(0)}
        </div>
        <div class="stat-label">Best P&L (${bestPnl.modelName})</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${(bestAccuracy.metrics.predictionMetrics.accuracy * 100).toFixed(1)}%</div>
        <div class="stat-label">Best Accuracy (${bestAccuracy.modelName})</div>
      </div>
      <div class="stat-card">
        <div class="stat-value ${avgPnl >= 0 ? "positive" : "negative"}">
          ${avgPnl >= 0 ? "+" : ""}$${avgPnl.toFixed(0)}
        </div>
        <div class="stat-label">Average P&L</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${(avgAccuracy * 100).toFixed(1)}%</div>
        <div class="stat-label">Average Accuracy</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${results.length}</div>
        <div class="stat-label">Models Tested</div>
      </div>
    </div>`;
  }

  /**
   * Generate P&L chart card
   */
  private static generatePnLChartCard(): string {
    return `
    <div class="card">
      <h3 class="card-title">💰 Total P&L Comparison</h3>
      <div class="chart-container">
        <canvas id="pnlChart"></canvas>
      </div>
    </div>`;
  }

  /**
   * Generate accuracy chart card
   */
  private static generateAccuracyChartCard(): string {
    return `
    <div class="card">
      <h3 class="card-title">🎯 Prediction Accuracy</h3>
      <div class="chart-container">
        <canvas id="accuracyChart"></canvas>
      </div>
    </div>`;
  }

  /**
   * Generate perp metrics chart card
   */
  private static generatePerpMetricsChartCard(): string {
    return `
    <div class="card">
      <h3 class="card-title">📈 Perpetual Trading Metrics</h3>
      <div class="chart-container">
        <canvas id="perpChart"></canvas>
      </div>
    </div>`;
  }

  /**
   * Generate timing chart card
   */
  private static generateTimingChartCard(): string {
    return `
    <div class="card">
      <h3 class="card-title">⏱️ Response Time</h3>
      <div class="chart-container">
        <canvas id="timingChart"></canvas>
      </div>
    </div>`;
  }

  /**
   * Generate comparison table
   */
  private static generateComparisonTable(
    results: ModelComparisonData[],
  ): string {
    // Sort by P&L descending
    const sorted = [...results].sort(
      (a, b) => b.metrics.totalPnl - a.metrics.totalPnl,
    );
    const bestPnlModel = sorted[0]?.modelId;

    const rows = sorted
      .map((r) => {
        const pnlClass = r.metrics.totalPnl >= 0 ? "positive" : "negative";
        const isWinner = r.modelId === bestPnlModel;
        const accuracyBadge =
          r.metrics.predictionMetrics.accuracy >= 0.6
            ? "badge-success"
            : r.metrics.predictionMetrics.accuracy >= 0.4
              ? "badge-warning"
              : "badge-danger";

        return `
      <tr>
        <td>
          <strong>${r.modelName}</strong>
          ${isWinner ? '<span class="winner-tag">🏆 Winner</span>' : ""}
        </td>
        <td class="${pnlClass}">
          ${r.metrics.totalPnl >= 0 ? "+" : ""}$${r.metrics.totalPnl.toFixed(2)}
        </td>
        <td>
          <span class="badge ${accuracyBadge}">
            ${(r.metrics.predictionMetrics.accuracy * 100).toFixed(1)}%
          </span>
        </td>
        <td>${r.metrics.predictionMetrics.correctPredictions}/${r.metrics.predictionMetrics.totalPositions}</td>
        <td>${r.metrics.perpMetrics.totalTrades}</td>
        <td>${(r.metrics.perpMetrics.winRate * 100).toFixed(1)}%</td>
        <td>${r.metrics.optimalityScore.toFixed(1)}%</td>
        <td>${(r.metrics.timing.totalDuration / 1000).toFixed(1)}s</td>
      </tr>`;
      })
      .join("");

    return `
    <div class="card" style="margin-top: 1.5rem;">
      <h3 class="card-title">📋 Detailed Comparison</h3>
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Total P&L</th>
            <th>Accuracy</th>
            <th>Correct/Total</th>
            <th>Perp Trades</th>
            <th>Win Rate</th>
            <th>Optimality</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>`;
  }

  /**
   * Generate history section
   */
  private static generateHistorySection(
    history: BenchmarkHistoryEntry[],
  ): string {
    if (history.length === 0) return "";

    // Group by model
    const byModel = new Map<string, BenchmarkHistoryEntry[]>();
    for (const entry of history) {
      const entries = byModel.get(entry.modelId) ?? [];
      entries.push(entry);
      byModel.set(entry.modelId, entries);
    }

    return `
    <div class="card" style="margin-top: 1.5rem;">
      <h3 class="card-title">📈 Historical Performance</h3>
      <div class="chart-container" style="height: 400px;">
        <canvas id="historyChart"></canvas>
      </div>
    </div>`;
  }

  /**
   * Generate Chart.js scripts
   */
  private static generateChartScripts(results: ModelComparisonData[]): string {
    const labels = results.map((r) => r.modelName);
    const pnlData = results.map((r) => r.metrics.totalPnl);
    const accuracyData = results.map(
      (r) => r.metrics.predictionMetrics.accuracy * 100,
    );
    const winRateData = results.map((r) => r.metrics.perpMetrics.winRate * 100);
    const optimalityData = results.map((r) => r.metrics.optimalityScore);
    const durationData = results.map(
      (r) => r.metrics.timing.totalDuration / 1000,
    );

    const pnlColors = pnlData.map((v) =>
      v >= 0 ? CHART_COLORS.success : CHART_COLORS.danger,
    );

    return `
    // P&L Chart
    new Chart(document.getElementById('pnlChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(labels)},
        datasets: [{
          label: 'Total P&L ($)',
          data: ${JSON.stringify(pnlData)},
          backgroundColor: ${JSON.stringify(pnlColors)},
          borderRadius: 8,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: '#334155' }
          },
          x: {
            grid: { display: false }
          }
        }
      }
    });
    
    // Accuracy Chart
    new Chart(document.getElementById('accuracyChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(labels)},
        datasets: [{
          label: 'Prediction Accuracy (%)',
          data: ${JSON.stringify(accuracyData)},
          backgroundColor: '${CHART_COLORS.primary}',
          borderRadius: 8,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            grid: { color: '#334155' }
          },
          x: {
            grid: { display: false }
          }
        }
      }
    });
    
    // Perp Metrics Chart (grouped bar)
    new Chart(document.getElementById('perpChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(labels)},
        datasets: [
          {
            label: 'Win Rate (%)',
            data: ${JSON.stringify(winRateData)},
            backgroundColor: '${CHART_COLORS.success}',
            borderRadius: 4,
          },
          {
            label: 'Optimality (%)',
            data: ${JSON.stringify(optimalityData)},
            backgroundColor: '${CHART_COLORS.purple}',
            borderRadius: 4,
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            grid: { color: '#334155' }
          },
          x: {
            grid: { display: false }
          }
        }
      }
    });
    
    // Timing Chart
    new Chart(document.getElementById('timingChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(labels)},
        datasets: [{
          label: 'Total Duration (s)',
          data: ${JSON.stringify(durationData)},
          backgroundColor: '${CHART_COLORS.cyan}',
          borderRadius: 8,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: '#334155' }
          },
          x: {
            grid: { display: false }
          }
        }
      }
    });`;
  }

  /**
   * Generate a simple terminal-friendly chart using ASCII
   */
  static generateTerminalChart(
    title: string,
    data: Array<{ label: string; value: number }>,
    options: { width?: number; valueFormat?: (v: number) => string } = {},
  ): string {
    const width = options.width ?? 40;
    const formatValue = options.valueFormat ?? ((v: number) => v.toFixed(2));

    const maxValue = Math.max(...data.map((d) => Math.abs(d.value)));
    const maxLabelLen = Math.max(...data.map((d) => d.label.length));

    const lines: string[] = [];
    lines.push(`\n  ${title}`);
    lines.push(`  ${"─".repeat(width + maxLabelLen + 20)}`);

    for (const item of data) {
      const normalizedValue =
        maxValue > 0 ? Math.abs(item.value) / maxValue : 0;
      const barLen = Math.round(normalizedValue * width);
      const bar = item.value >= 0 ? "█".repeat(barLen) : "░".repeat(barLen);
      const color = item.value >= 0 ? "\x1b[32m" : "\x1b[31m";
      const reset = "\x1b[0m";
      const paddedLabel = item.label.padEnd(maxLabelLen);

      lines.push(
        `  ${paddedLabel} │${color}${bar}${reset} ${formatValue(item.value)}`,
      );
    }

    lines.push(`  ${"─".repeat(width + maxLabelLen + 20)}`);

    return lines.join("\n");
  }

  /**
   * Generate a comparison summary for terminal output
   */
  static generateTerminalSummary(results: ModelComparisonData[]): string {
    const sorted = [...results].sort(
      (a, b) => b.metrics.totalPnl - a.metrics.totalPnl,
    );
    const winner = sorted[0];

    const lines: string[] = [];
    lines.push("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("📊 BENCHMARK RESULTS");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // P&L Chart
    lines.push(
      BenchmarkChartGenerator.generateTerminalChart(
        "💰 Total P&L",
        sorted.map((r) => ({ label: r.modelName, value: r.metrics.totalPnl })),
        { valueFormat: (v) => `$${v.toFixed(2)}` },
      ),
    );

    // Accuracy Chart
    lines.push(
      BenchmarkChartGenerator.generateTerminalChart(
        "🎯 Prediction Accuracy",
        sorted.map((r) => ({
          label: r.modelName,
          value: r.metrics.predictionMetrics.accuracy * 100,
        })),
        { valueFormat: (v) => `${v.toFixed(1)}%` },
      ),
    );

    // Winner
    if (winner) {
      const loser = sorted[sorted.length - 1];
      const pnlDelta = winner.metrics.totalPnl - (loser?.metrics.totalPnl ?? 0);

      lines.push("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      lines.push(`🏆 WINNER: ${winner.modelName}`);
      lines.push(`   P&L: $${winner.metrics.totalPnl.toFixed(2)}`);
      lines.push(
        `   Accuracy: ${(winner.metrics.predictionMetrics.accuracy * 100).toFixed(1)}%`,
      );
      if (results.length > 1 && loser) {
        lines.push(`   Lead: $${pnlDelta.toFixed(2)} over ${loser.modelName}`);
      }
      lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    }

    return lines.join("\n");
  }
}
