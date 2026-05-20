/**
 * Simulation Report Generator
 *
 * @module simulation/simulation-report
 *
 * @description
 * Generates human-readable reports and analytics from liquidity simulations.
 * Outputs can be console logs, JSON files, or structured data for dashboards.
 *
 * @example
 * ```typescript
 * const results = await simulator.run();
 * const report = generateReport(results);
 * console.log(report.summary);
 * ```
 */

// TODO: liquidity-simulation module not yet implemented
// import type {
//   LiquidityScenarioConfig,
//   SimulationResult,
//   TickMetrics,
// } from './liquidity-simulation';

// Temporary stub types until liquidity-simulation is implemented
export interface LiquidityScenarioConfig {
  name: string;
  description: string;
}

export interface SimulationResult {
  id: string;
  metrics: Record<string, number>;
  config: LiquidityScenarioConfig;
  tickMetrics: TickMetrics[];
  durationTicks: number;
  simulatedTimeSeconds: number;
  initialHealthScore: number;
  finalHealthScore: number;
  lowestHealthScore: number;
  avgHealthScore: number;
  finalPerpState: {
    longOI: number;
    shortOI: number;
    imbalance: number;
    imbalancePercent: number;
    fundingRate: number;
    spotPrice: number;
    totalFundingPaid: number;
    avgFundingRateAPR: number;
  };
  finalPredictionState: {
    activeMarkets: number;
    totalLiquidity: number;
    avgSpread: number;
    volume: number;
    totalVolume: number;
    npcNetPnL: number;
    userNetPnL: number;
  };
  eventsTriggered: string[];
  findings: string[];
  recommendations: string[];
}

export interface TickMetrics {
  tick: number;
  timestamp: number;
  perpLongOI: number;
  perpShortOI: number;
  perpImbalance: number;
  perpFundingRate: number;
  perpSpotPrice: number;
  predictionTotalLiquidity: number;
  predictionAvgSpread: number;
  predictionVolume: number;
  overallHealthScore: number;
}

/**
 * Report summary section
 */
export interface ReportSummary {
  scenarioName: string;
  description: string;

  duration: {
    ticks: number;
    simulatedSeconds: number;
    simulatedHours: number;
  };

  health: {
    initial: number;
    final: number;
    lowest: number;
    average: number;
    trend: 'improving' | 'declining' | 'stable';
  };

  perpMarket: {
    finalLongOI: string;
    finalShortOI: string;
    imbalancePercent: string;
    totalFundingPaid: string;
    avgFundingRateAPR: string;
  };

  predictionMarket: {
    finalLiquidity: string;
    avgSpread: string;
    totalVolume: string;
    npcNetPnL: string;
    userNetPnL: string;
  };

  eventsTriggered: number;
  findings: string[];
  recommendations: string[];
}

/**
 * Time series analysis
 */
export interface TimeSeriesAnalysis {
  perpImbalance: {
    min: number;
    max: number;
    avg: number;
    volatility: number;
  };

  fundingRate: {
    min: number;
    max: number;
    avg: number;
  };

  spotPrice: {
    min: number;
    max: number;
    change: number;
    volatility: number;
  };

  predictionLiquidity: {
    min: number;
    max: number;
    change: number;
  };

  healthScore: {
    min: number;
    max: number;
    avg: number;
    volatility: number;
    timesBelowThreshold: {
      critical: number; // Below 20
      poor: number; // Below 40
      fair: number; // Below 60
    };
  };
}

/**
 * Full simulation report
 */
export interface SimulationReport {
  generatedAt: Date;
  summary: ReportSummary;
  timeSeries: TimeSeriesAnalysis;
  rawMetrics: TickMetrics[];
  config: LiquidityScenarioConfig;
}

/**
 * Generate a comprehensive report from simulation results
 */
export function generateReport(result: SimulationResult): SimulationReport {
  const summary = generateSummary(result);
  const timeSeries = analyzeTimeSeries(result.tickMetrics);

  return {
    generatedAt: new Date(),
    summary,
    timeSeries,
    rawMetrics: result.tickMetrics,
    config: result.config,
  };
}

/**
 * Generate summary section
 */
function generateSummary(result: SimulationResult): ReportSummary {
  const healthTrend =
    result.finalHealthScore > result.initialHealthScore + 5
      ? 'improving'
      : result.finalHealthScore < result.initialHealthScore - 5
        ? 'declining'
        : 'stable';

  return {
    scenarioName: result.config.name,
    description: result.config.description,

    duration: {
      ticks: result.durationTicks,
      simulatedSeconds: result.simulatedTimeSeconds,
      simulatedHours: result.simulatedTimeSeconds / 3600,
    },

    health: {
      initial: result.initialHealthScore,
      final: result.finalHealthScore,
      lowest: result.lowestHealthScore,
      average: result.avgHealthScore,
      trend: healthTrend,
    },

    perpMarket: {
      finalLongOI: formatCurrency(result.finalPerpState.longOI),
      finalShortOI: formatCurrency(result.finalPerpState.shortOI),
      imbalancePercent: `${result.finalPerpState.imbalancePercent.toFixed(1)}%`,
      totalFundingPaid: formatCurrency(result.finalPerpState.totalFundingPaid),
      avgFundingRateAPR: `${result.finalPerpState.avgFundingRateAPR.toFixed(2)}%`,
    },

    predictionMarket: {
      finalLiquidity: formatCurrency(
        result.finalPredictionState.totalLiquidity
      ),
      avgSpread: `${result.finalPredictionState.avgSpread.toFixed(0)} bps`,
      totalVolume: formatCurrency(result.finalPredictionState.totalVolume),
      npcNetPnL: formatCurrencySigned(result.finalPredictionState.npcNetPnL),
      userNetPnL: formatCurrencySigned(result.finalPredictionState.userNetPnL),
    },

    eventsTriggered: result.eventsTriggered.length,
    findings: result.findings,
    recommendations: result.recommendations,
  };
}

/**
 * Analyze time series metrics
 */
function analyzeTimeSeries(metrics: TickMetrics[]): TimeSeriesAnalysis {
  if (metrics.length === 0) {
    return createEmptyAnalysis();
  }

  // Extract arrays
  const perpImbalances = metrics.map((m) => m.perpImbalance);
  const fundingRates = metrics.map((m) => m.perpFundingRate);
  const spotPrices = metrics.map((m) => m.perpSpotPrice);
  const liquidity = metrics.map((m) => m.predictionTotalLiquidity);
  const healthScores = metrics.map((m) => m.overallHealthScore);

  return {
    perpImbalance: {
      min: Math.min(...perpImbalances),
      max: Math.max(...perpImbalances),
      avg: average(perpImbalances),
      volatility: standardDeviation(perpImbalances),
    },

    fundingRate: {
      min: Math.min(...fundingRates),
      max: Math.max(...fundingRates),
      avg: average(fundingRates),
    },

    spotPrice: {
      min: Math.min(...spotPrices),
      max: Math.max(...spotPrices),
      change: (spotPrices[spotPrices.length - 1] ?? 0) - (spotPrices[0] ?? 0),
      volatility: standardDeviation(spotPrices),
    },

    predictionLiquidity: {
      min: Math.min(...liquidity),
      max: Math.max(...liquidity),
      change: (liquidity[liquidity.length - 1] ?? 0) - (liquidity[0] ?? 0),
    },

    healthScore: {
      min: Math.min(...healthScores),
      max: Math.max(...healthScores),
      avg: average(healthScores),
      volatility: standardDeviation(healthScores),
      timesBelowThreshold: {
        critical: healthScores.filter((h) => h < 20).length,
        poor: healthScores.filter((h) => h < 40).length,
        fair: healthScores.filter((h) => h < 60).length,
      },
    },
  };
}

/**
 * Create empty analysis for edge cases
 */
function createEmptyAnalysis(): TimeSeriesAnalysis {
  return {
    perpImbalance: { min: 0, max: 0, avg: 0, volatility: 0 },
    fundingRate: { min: 0, max: 0, avg: 0 },
    spotPrice: { min: 0, max: 0, change: 0, volatility: 0 },
    predictionLiquidity: { min: 0, max: 0, change: 0 },
    healthScore: {
      min: 0,
      max: 0,
      avg: 0,
      volatility: 0,
      timesBelowThreshold: { critical: 0, poor: 0, fair: 0 },
    },
  };
}

/**
 * Generate console-friendly report
 */
export function formatReportForConsole(report: SimulationReport): string {
  const s = report.summary;
  const t = report.timeSeries;

  const lines: string[] = [
    '',
    '═══════════════════════════════════════════════════════════════',
    `LIQUIDITY SIMULATION REPORT: ${s.scenarioName}`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `Description: ${s.description}`,
    `Duration: ${s.duration.ticks} ticks (${s.duration.simulatedHours.toFixed(1)} simulated hours)`,
    `Generated: ${report.generatedAt.toISOString()}`,
    '',
    '───────────────────────────────────────────────────────────────',
    'HEALTH OVERVIEW',
    '───────────────────────────────────────────────────────────────',
    `  Initial Score: ${s.health.initial}`,
    `  Final Score:   ${s.health.final} (${s.health.trend})`,
    `  Lowest Score:  ${s.health.lowest}`,
    `  Average Score: ${s.health.average.toFixed(1)}`,
    '',
    '───────────────────────────────────────────────────────────────',
    'PERPETUAL MARKET',
    '───────────────────────────────────────────────────────────────',
    `  Long OI:          ${s.perpMarket.finalLongOI}`,
    `  Short OI:         ${s.perpMarket.finalShortOI}`,
    `  Imbalance:        ${s.perpMarket.imbalancePercent}`,
    `  Avg Funding APR:  ${s.perpMarket.avgFundingRateAPR}`,
    `  Total Funding:    ${s.perpMarket.totalFundingPaid}`,
    '',
    `  Price Range:      ${t.spotPrice.min.toFixed(2)} - ${t.spotPrice.max.toFixed(2)}`,
    `  Price Change:     ${t.spotPrice.change >= 0 ? '+' : ''}${t.spotPrice.change.toFixed(2)}`,
    `  Price Volatility: ${(t.spotPrice.volatility * 100).toFixed(2)}%`,
    '',
    '───────────────────────────────────────────────────────────────',
    'PREDICTION MARKETS',
    '───────────────────────────────────────────────────────────────',
    `  Final Liquidity:  ${s.predictionMarket.finalLiquidity}`,
    `  Avg Spread:       ${s.predictionMarket.avgSpread}`,
    `  Total Volume:     ${s.predictionMarket.totalVolume}`,
    `  NPC Net P&L:      ${s.predictionMarket.npcNetPnL}`,
    `  User Net P&L:     ${s.predictionMarket.userNetPnL}`,
    '',
    `  Liquidity Range:  ${t.predictionLiquidity.min.toFixed(0)} - ${t.predictionLiquidity.max.toFixed(0)}`,
    `  Liquidity Change: ${t.predictionLiquidity.change >= 0 ? '+' : ''}${t.predictionLiquidity.change.toFixed(0)}`,
    '',
    '───────────────────────────────────────────────────────────────',
    'HEALTH ANALYSIS',
    '───────────────────────────────────────────────────────────────',
    `  Times Critical (<20): ${t.healthScore.timesBelowThreshold.critical}`,
    `  Times Poor (<40):     ${t.healthScore.timesBelowThreshold.poor}`,
    `  Times Fair (<60):     ${t.healthScore.timesBelowThreshold.fair}`,
    `  Health Volatility:    ${t.healthScore.volatility.toFixed(1)}`,
    '',
  ];

  if (s.eventsTriggered > 0) {
    lines.push(
      '───────────────────────────────────────────────────────────────'
    );
    lines.push('EVENTS TRIGGERED');
    lines.push(
      '───────────────────────────────────────────────────────────────'
    );
    lines.push(`  Count: ${s.eventsTriggered}`);
    lines.push('');
  }

  if (s.findings.length > 0) {
    lines.push(
      '───────────────────────────────────────────────────────────────'
    );
    lines.push('FINDINGS');
    lines.push(
      '───────────────────────────────────────────────────────────────'
    );
    for (const finding of s.findings) {
      lines.push(`  • ${finding}`);
    }
    lines.push('');
  }

  if (s.recommendations.length > 0) {
    lines.push(
      '───────────────────────────────────────────────────────────────'
    );
    lines.push('RECOMMENDATIONS');
    lines.push(
      '───────────────────────────────────────────────────────────────'
    );
    for (const rec of s.recommendations) {
      lines.push(`  → ${rec}`);
    }
    lines.push('');
  }

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');

  return lines.join('\n');
}

/**
 * Compare multiple simulation results
 */
export function compareScenarios(
  results: Map<string, SimulationResult>
): string {
  const lines: string[] = [
    '',
    '═══════════════════════════════════════════════════════════════',
    'SCENARIO COMPARISON',
    '═══════════════════════════════════════════════════════════════',
    '',
  ];

  // Header row
  const scenarios = Array.from(results.keys());
  lines.push(
    'Metric'.padEnd(30) + scenarios.map((s) => s.padStart(15)).join('')
  );
  lines.push('─'.repeat(30 + scenarios.length * 15));

  // Data rows
  const metrics = [
    {
      name: 'Final Health Score',
      getter: (r: SimulationResult) => r.finalHealthScore.toFixed(0),
    },
    {
      name: 'Lowest Health Score',
      getter: (r: SimulationResult) => r.lowestHealthScore.toFixed(0),
    },
    {
      name: 'Perp Imbalance %',
      getter: (r: SimulationResult) =>
        r.finalPerpState.imbalancePercent.toFixed(1),
    },
    {
      name: 'Avg Funding APR %',
      getter: (r: SimulationResult) =>
        r.finalPerpState.avgFundingRateAPR.toFixed(2),
    },
    {
      name: 'Pred Liquidity',
      getter: (r: SimulationResult) =>
        (r.finalPredictionState.totalLiquidity / 1000).toFixed(1) + 'k',
    },
    {
      name: 'NPC P&L',
      getter: (r: SimulationResult) =>
        formatCurrencySigned(r.finalPredictionState.npcNetPnL),
    },
    {
      name: 'User P&L',
      getter: (r: SimulationResult) =>
        formatCurrencySigned(r.finalPredictionState.userNetPnL),
    },
  ];

  for (const metric of metrics) {
    const values = scenarios.map((s) => {
      const result = results.get(s);
      return result ? metric.getter(result).padStart(15) : 'N/A'.padStart(15);
    });
    lines.push(metric.name.padEnd(30) + values.join(''));
  }

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');

  return lines.join('\n');
}

/**
 * Export results to JSON
 */
export function exportToJSON(report: SimulationReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Export time series to CSV format
 */
export function exportTimeSeriesCSV(metrics: TickMetrics[]): string {
  const headers = [
    'tick',
    'timestamp',
    'perpLongOI',
    'perpShortOI',
    'perpImbalance',
    'perpFundingRate',
    'perpSpotPrice',
    'predictionTotalLiquidity',
    'predictionAvgSpread',
    'predictionVolume',
    'overallHealthScore',
  ];

  const rows = metrics.map((m) =>
    [
      m.tick,
      m.timestamp,
      m.perpLongOI.toFixed(2),
      m.perpShortOI.toFixed(2),
      m.perpImbalance.toFixed(4),
      m.perpFundingRate.toFixed(6),
      m.perpSpotPrice.toFixed(2),
      m.predictionTotalLiquidity.toFixed(2),
      m.predictionAvgSpread.toFixed(2),
      m.predictionVolume.toFixed(2),
      m.overallHealthScore.toFixed(0),
    ].join(',')
  );

  return [headers.join(','), ...rows].join('\n');
}

// Utility functions

function formatCurrency(value: number): string {
  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}M`;
  }
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  return `$${value.toFixed(2)}`;
}

function formatCurrencySigned(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return sign + formatCurrency(value);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = average(values);
  const squareDiffs = values.map((v) => (v - avg) ** 2);
  return Math.sqrt(average(squareDiffs));
}
