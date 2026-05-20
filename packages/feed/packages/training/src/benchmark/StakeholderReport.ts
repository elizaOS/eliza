/**
 * Stakeholder Report Generator
 *
 * Generates executive-friendly benchmark reports suitable for presentations.
 * Focuses on high-level insights rather than technical details.
 *
 * Output formats:
 * - HTML: Styled report for viewing/sharing
 * - JSON: Structured data for dashboards
 * - Text: Summary for terminal/logs
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { formatCurrency, formatCurrencyWithSign } from '../utils';
import { logger } from '../utils/logger';
import type { ArchetypeFitScore } from './ArchetypeFitCalculator';
import type {
  FixedBenchmarkScenario,
  ScenarioSuccessCriteria,
} from './ScenarioLoader';
import type { SimulationResult } from './SimulationEngine';

// ============================================================================
// Constants
// ============================================================================

/**
 * Minimum P&L difference (in dollars) required to declare a winner.
 * Values within this threshold result in a "tie".
 */
const WINNER_THRESHOLD_DOLLARS = 50;

// Verdict determination thresholds (extracted for maintainability)
/** Minimum scenarios won to recommend deployment */
const DEPLOY_MIN_SCENARIOS_WON = 3;
/** Minimum scenarios lost to flag as regression */
const REGRESSION_MIN_SCENARIOS_LOST = 3;
/** Alpha threshold below which model is flagged as regression */
const REGRESSION_ALPHA_THRESHOLD = -500;

// ============================================================================
// Types
// ============================================================================

export interface AgentBenchmarkSummary {
  agentId: string;
  archetype: string;
  scenario: string;
  pnl: number;
  pnlPercent: number;
  accuracy: number;
  winRate: number;
  archetypeFitScore: number;
  trustScore?: number;
  criticalLossEvents?: number;
  socialCapitalScore?: number;
  informationSalesRevenue?: number;
  passedCriteria: boolean;
  criteriaDetails: string;
}

export interface ScenarioBenchmarkResult {
  scenarioId: string;
  scenarioName: string;
  marketCondition: string;
  baseline: AgentBenchmarkSummary;
  challenger: AgentBenchmarkSummary;
  improvement: {
    pnlDelta: number;
    pnlDeltaPercent: number;
    accuracyDelta: number;
    fitScoreDelta: number;
    trustScoreDelta?: number;
  };
  winner: 'baseline' | 'challenger' | 'tie';
  alphaGenerated: number;
}

export interface FullBenchmarkReport {
  generatedAt: string;
  modelVersion: string;
  baselineDescription: string;
  scenarios: ScenarioBenchmarkResult[];
  summary: {
    scenariosWon: number;
    scenariosLost: number;
    scenariosTied: number;
    totalAlpha: number;
    avgPnlImprovement: number;
    avgFitScoreImprovement: number;
    overallVerdict: 'deploy' | 'keep_training' | 'regression';
    verdictExplanation: string;
  };
  recommendations: string[];
}

// ============================================================================
// Success Criteria Evaluation
// ============================================================================

function evaluateCriteria(
  result: SimulationResult,
  archetype: string,
  criteria: ScenarioSuccessCriteria,
  baselinePnl: number
): { passed: boolean; details: string } {
  const pnl = result.metrics.totalPnl;
  const tradeCount = result.actions.filter((a) =>
    ['buy_prediction', 'sell_prediction', 'open_perp', 'close_perp'].includes(
      a.type
    )
  ).length;

  switch (archetype) {
    case 'trader': {
      // Trader should limit losses relative to baseline
      // Note: baselineLoss and traderLoss are negative (or zero) when there's a loss.
      // Dividing two negatives yields a positive ratio representing how much of
      // the baseline's loss the trader experienced.
      // Example: baseline lost -$100, trader lost -$50 → ratio = 0.5 (50% of baseline loss)
      // Pass condition: ratio <= 1 + traderMinPnlRatio
      // If traderMinPnlRatio = -0.5, trader must lose ≤50% of baseline loss to pass.
      const baselineLoss = baselinePnl < 0 ? baselinePnl : 0;
      const traderLoss = pnl < 0 ? pnl : 0;

      if (baselineLoss === 0) {
        // No baseline loss to compare against
        const passed = pnl >= 0;
        return {
          passed,
          details: passed
            ? `Trader achieved positive P&L: $${pnl.toFixed(2)}`
            : `Trader lost money: $${pnl.toFixed(2)}`,
        };
      }

      const lossRatio = traderLoss / baselineLoss;
      const passed = lossRatio <= 1 + criteria.traderMinPnlRatio;
      return {
        passed,
        details: passed
          ? `Trader limited losses to ${(lossRatio * 100).toFixed(0)}% of baseline loss (target: <${((1 + criteria.traderMinPnlRatio) * 100).toFixed(0)}%)`
          : `Trader lost ${(lossRatio * 100).toFixed(0)}% of baseline loss (target: <${((1 + criteria.traderMinPnlRatio) * 100).toFixed(0)}%)`,
      };
    }

    case 'scammer': {
      // Scammer should extract alpha
      const alpha = pnl - baselinePnl;
      const passed = alpha >= criteria.scammerMinAlpha;
      return {
        passed,
        details: passed
          ? `Scammer extracted ${formatCurrency(alpha)} alpha (target: >${formatCurrency(criteria.scammerMinAlpha)})`
          : `Scammer extracted only ${formatCurrency(alpha)} alpha (target: >${formatCurrency(criteria.scammerMinAlpha)})`,
      };
    }

    case 'degen': {
      // Degen should maintain high activity
      const passed = tradeCount >= criteria.degenMinTrades;
      return {
        passed,
        details: passed
          ? `Degen completed ${tradeCount} trades (target: ≥${criteria.degenMinTrades})`
          : `Degen only completed ${tradeCount} trades (target: ≥${criteria.degenMinTrades})`,
      };
    }

    default: {
      // Default: just check positive P&L
      const passed = pnl >= 0;
      return {
        passed,
        details: passed
          ? `Agent achieved positive P&L: ${formatCurrency(pnl)}`
          : `Agent lost money: ${formatCurrency(pnl)}`,
      };
    }
  }
}

// ============================================================================
// Report Generation
// ============================================================================

function createAgentSummary(
  result: SimulationResult,
  archetype: string,
  scenarioId: string,
  fitScore: ArchetypeFitScore,
  criteria: ScenarioSuccessCriteria,
  baselinePnl: number,
  startingBalance: number = 10000
): AgentBenchmarkSummary {
  const criteriaEval = evaluateCriteria(
    result,
    archetype,
    criteria,
    baselinePnl
  );

  return {
    agentId: result.agentId,
    archetype,
    scenario: scenarioId,
    pnl: result.metrics.totalPnl,
    pnlPercent: (result.metrics.totalPnl / startingBalance) * 100,
    accuracy: result.metrics.predictionMetrics.accuracy,
    winRate: result.metrics.perpMetrics.winRate,
    archetypeFitScore: fitScore.fitScore,
    trustScore: result.metrics.trustMetrics?.trustScore,
    criticalLossEvents: result.metrics.trustMetrics?.criticalLossEvents,
    socialCapitalScore: result.metrics.trustMetrics?.socialCapitalScore,
    informationSalesRevenue:
      result.metrics.trustMetrics?.informationSalesRevenue,
    passedCriteria: criteriaEval.passed,
    criteriaDetails: criteriaEval.details,
  };
}

function createScenarioResult(
  scenario: FixedBenchmarkScenario,
  baselineResult: SimulationResult,
  challengerResult: SimulationResult,
  baselineFit: ArchetypeFitScore,
  challengerFit: ArchetypeFitScore,
  archetype: string,
  startingBalance: number = 10000
): ScenarioBenchmarkResult {
  const baselineSummary = createAgentSummary(
    baselineResult,
    archetype,
    scenario.id,
    baselineFit,
    scenario.successCriteria,
    0, // Baseline compares to itself
    startingBalance
  );

  const challengerSummary = createAgentSummary(
    challengerResult,
    archetype,
    scenario.id,
    challengerFit,
    scenario.successCriteria,
    baselineResult.metrics.totalPnl,
    startingBalance
  );

  const pnlDelta =
    challengerResult.metrics.totalPnl - baselineResult.metrics.totalPnl;
  const pnlDeltaPercent = (pnlDelta / startingBalance) * 100;
  const accuracyDelta =
    challengerResult.metrics.predictionMetrics.accuracy -
    baselineResult.metrics.predictionMetrics.accuracy;
  const fitScoreDelta = challengerFit.fitScore - baselineFit.fitScore;
  const trustScoreDelta =
    challengerSummary.trustScore !== undefined &&
    baselineSummary.trustScore !== undefined
      ? challengerSummary.trustScore - baselineSummary.trustScore
      : undefined;

  let winner: 'baseline' | 'challenger' | 'tie';
  if (pnlDelta > WINNER_THRESHOLD_DOLLARS) {
    winner = 'challenger';
  } else if (pnlDelta < -WINNER_THRESHOLD_DOLLARS) {
    winner = 'baseline';
  } else {
    winner = 'tie';
  }

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    marketCondition: scenario.marketCondition,
    baseline: baselineSummary,
    challenger: challengerSummary,
    improvement: {
      pnlDelta,
      pnlDeltaPercent,
      accuracyDelta,
      fitScoreDelta,
      trustScoreDelta,
    },
    winner,
    alphaGenerated: pnlDelta,
  };
}

function calculateOverallVerdict(
  scenarios: ScenarioBenchmarkResult[]
): FullBenchmarkReport['summary'] {
  const scenariosWon = scenarios.filter(
    (s) => s.winner === 'challenger'
  ).length;
  const scenariosLost = scenarios.filter((s) => s.winner === 'baseline').length;
  const scenariosTied = scenarios.filter((s) => s.winner === 'tie').length;
  const totalAlpha = scenarios.reduce((sum, s) => sum + s.alphaGenerated, 0);

  // Guard against division by zero if scenarios is empty
  const scenarioCount = scenarios.length || 1;
  const avgPnlImprovement =
    scenarios.reduce((sum, s) => sum + s.improvement.pnlDeltaPercent, 0) /
    scenarioCount;
  const avgFitScoreImprovement =
    scenarios.reduce((sum, s) => sum + s.improvement.fitScoreDelta, 0) /
    scenarioCount;

  let overallVerdict: 'deploy' | 'keep_training' | 'regression';
  let verdictExplanation: string;

  if (scenariosWon >= DEPLOY_MIN_SCENARIOS_WON && totalAlpha > 0) {
    overallVerdict = 'deploy';
    verdictExplanation = `Model won ${scenariosWon}/${scenarios.length} scenarios with ${formatCurrency(totalAlpha)} total alpha. Ready for deployment.`;
  } else if (
    scenariosLost >= REGRESSION_MIN_SCENARIOS_LOST ||
    totalAlpha < REGRESSION_ALPHA_THRESHOLD
  ) {
    overallVerdict = 'regression';
    verdictExplanation = `Model lost ${scenariosLost}/${scenarios.length} scenarios with ${formatCurrency(totalAlpha)} total alpha. Training regressed - investigate.`;
  } else {
    overallVerdict = 'keep_training';
    verdictExplanation = `Model shows mixed results (${scenariosWon}W/${scenariosLost}L/${scenariosTied}T). Continue training for improvement.`;
  }

  return {
    scenariosWon,
    scenariosLost,
    scenariosTied,
    totalAlpha,
    avgPnlImprovement,
    avgFitScoreImprovement,
    overallVerdict,
    verdictExplanation,
  };
}

function generateRecommendations(
  scenarios: ScenarioBenchmarkResult[],
  summary: FullBenchmarkReport['summary']
): string[] {
  const recommendations: string[] = [];

  // Based on overall verdict
  if (summary.overallVerdict === 'deploy') {
    recommendations.push(
      '✅ Model performance exceeds baseline - proceed with deployment'
    );
    recommendations.push(
      '📊 Monitor production metrics closely for first 24 hours'
    );
  } else if (summary.overallVerdict === 'regression') {
    recommendations.push('⚠️ Model shows regression - DO NOT deploy');
    recommendations.push('🔍 Review recent training changes and data quality');
    recommendations.push('📈 Consider reverting to previous checkpoint');
  } else {
    recommendations.push(
      '🔄 Continue training with focus on underperforming scenarios'
    );
  }

  // Scenario-specific recommendations
  for (const scenario of scenarios) {
    if (scenario.winner === 'baseline') {
      if (scenario.scenarioId === 'bear-market') {
        recommendations.push(
          '💰 Improve capital protection in downturns - model loses too much in bear markets'
        );
      } else if (scenario.scenarioId === 'scandal-unfolds') {
        recommendations.push(
          '🔍 Improve information processing - model fails to recognize warning signals'
        );
      } else if (scenario.scenarioId === 'pump-and-dump') {
        recommendations.push(
          '🎯 Increase skepticism training - model falls for manipulation'
        );
      }
    }

    if (scenario.improvement.fitScoreDelta < -0.1) {
      recommendations.push(
        `🎭 Archetype alignment degraded in ${scenario.scenarioName} - review training data`
      );
    }
  }

  // Activity recommendations
  const lowActivityScenarios = scenarios.filter(
    (s) => s.challenger.archetypeFitScore < 0.4
  );
  if (lowActivityScenarios.length > 0) {
    recommendations.push(
      '⚡ Increase agent activity - low engagement in some scenarios'
    );
  }

  return recommendations;
}

// ============================================================================
// Output Formatters
// ============================================================================

export class StakeholderReportGenerator {
  /**
   * Generate a full benchmark report
   */
  static createReport(
    modelVersion: string,
    baselineDescription: string,
    scenarioResults: Array<{
      scenario: FixedBenchmarkScenario;
      baselineResult: SimulationResult;
      challengerResult: SimulationResult;
      baselineFit: ArchetypeFitScore;
      challengerFit: ArchetypeFitScore;
      archetype: string;
    }>,
    startingBalance: number = 10000
  ): FullBenchmarkReport {
    const scenarios = scenarioResults.map((sr) =>
      createScenarioResult(
        sr.scenario,
        sr.baselineResult,
        sr.challengerResult,
        sr.baselineFit,
        sr.challengerFit,
        sr.archetype,
        startingBalance
      )
    );

    const summary = calculateOverallVerdict(scenarios);
    const recommendations = generateRecommendations(scenarios, summary);

    return {
      generatedAt: new Date().toISOString(),
      modelVersion,
      baselineDescription,
      scenarios,
      summary,
      recommendations,
    };
  }

  /**
   * Generate HTML report
   *
   * Note: Report content is interpolated directly into HTML. Currently this is safe
   * because all data comes from internal JSON files with no user input. If user-provided
   * data is ever added to reports, consider using a sanitization library (e.g., DOMPurify)
   * or a template engine with auto-escaping (e.g., Handlebars).
   */
  static async generateHtml(
    report: FullBenchmarkReport,
    outputPath: string
  ): Promise<void> {
    const verdictColor =
      report.summary.overallVerdict === 'deploy'
        ? '#10b981'
        : report.summary.overallVerdict === 'regression'
          ? '#ef4444'
          : '#f59e0b';

    const verdictEmoji =
      report.summary.overallVerdict === 'deploy'
        ? '✅'
        : report.summary.overallVerdict === 'regression'
          ? '❌'
          : '🔄';

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Benchmark Report - ${report.modelVersion}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      line-height: 1.6;
      padding: 40px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { font-size: 2.5rem; margin-bottom: 8px; }
    .subtitle { color: #94a3b8; margin-bottom: 32px; }
    .card {
      background: #1e293b;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .card h2 {
      font-size: 1.25rem;
      margin-bottom: 16px;
      color: #f8fafc;
    }
    .verdict {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 1.5rem;
      font-weight: 600;
      color: ${verdictColor};
      padding: 16px 24px;
      background: ${verdictColor}20;
      border-radius: 8px;
      margin-bottom: 16px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .stat {
      background: #334155;
      padding: 16px;
      border-radius: 8px;
      text-align: center;
    }
    .stat-value {
      font-size: 2rem;
      font-weight: 700;
      color: #f8fafc;
    }
    .stat-label { color: #94a3b8; font-size: 0.875rem; }
    .positive { color: #10b981; }
    .negative { color: #ef4444; }
    .neutral { color: #f59e0b; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 16px;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #334155;
    }
    th { color: #94a3b8; font-weight: 500; font-size: 0.875rem; }
    .winner-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .winner-challenger { background: #10b98120; color: #10b981; }
    .winner-baseline { background: #ef444420; color: #ef4444; }
    .winner-tie { background: #94a3b820; color: #94a3b8; }
    .recommendations {
      list-style: none;
    }
    .recommendations li {
      padding: 12px 16px;
      background: #334155;
      border-radius: 8px;
      margin-bottom: 8px;
    }
    .footer {
      text-align: center;
      color: #64748b;
      margin-top: 40px;
      padding-top: 24px;
      border-top: 1px solid #334155;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 Benchmark Report</h1>
    <p class="subtitle">Model: ${report.modelVersion} | Baseline: ${report.baselineDescription} | Generated: ${new Date(report.generatedAt).toLocaleString()}</p>

    <div class="card">
      <div class="verdict">${verdictEmoji} ${report.summary.overallVerdict.toUpperCase()}</div>
      <p>${report.summary.verdictExplanation}</p>
    </div>

    <div class="stats-grid">
      <div class="stat">
        <div class="stat-value ${report.summary.scenariosWon > report.summary.scenariosLost ? 'positive' : report.summary.scenariosWon < report.summary.scenariosLost ? 'negative' : 'neutral'}">
          ${report.summary.scenariosWon}/${report.scenarios.length}
        </div>
        <div class="stat-label">Scenarios Won</div>
      </div>
      <div class="stat">
        <div class="stat-value ${report.summary.totalAlpha >= 0 ? 'positive' : 'negative'}">
          ${formatCurrency(report.summary.totalAlpha, 0)}
        </div>
        <div class="stat-label">Total Alpha</div>
      </div>
      <div class="stat">
        <div class="stat-value ${report.summary.avgPnlImprovement >= 0 ? 'positive' : 'negative'}">
          ${report.summary.avgPnlImprovement >= 0 ? '+' : ''}${report.summary.avgPnlImprovement.toFixed(1)}%
        </div>
        <div class="stat-label">Avg P&L Improvement</div>
      </div>
      <div class="stat">
        <div class="stat-value ${report.summary.avgFitScoreImprovement >= 0 ? 'positive' : 'negative'}">
          ${report.summary.avgFitScoreImprovement >= 0 ? '+' : ''}${(report.summary.avgFitScoreImprovement * 100).toFixed(0)}%
        </div>
        <div class="stat-label">Avg Fit Score Change</div>
      </div>
    </div>

    <div class="card">
      <h2>Scenario Results</h2>
      <table>
        <thead>
          <tr>
            <th>Scenario</th>
            <th>Market</th>
            <th>Baseline P&L</th>
            <th>Challenger P&L</th>
            <th>Alpha</th>
            <th>Fit Score Δ</th>
            <th>Winner</th>
          </tr>
        </thead>
        <tbody>
          ${report.scenarios
            .map(
              (s) => `
          <tr>
            <td><strong>${s.scenarioName}</strong></td>
            <td>${s.marketCondition}</td>
            <td class="${s.baseline.pnl >= 0 ? 'positive' : 'negative'}">${formatCurrency(s.baseline.pnl, 0)}</td>
            <td class="${s.challenger.pnl >= 0 ? 'positive' : 'negative'}">${formatCurrency(s.challenger.pnl, 0)}</td>
            <td class="${s.alphaGenerated >= 0 ? 'positive' : 'negative'}">${formatCurrencyWithSign(s.alphaGenerated, 0)}</td>
            <td class="${s.improvement.fitScoreDelta >= 0 ? 'positive' : 'negative'}">${s.improvement.fitScoreDelta >= 0 ? '+' : ''}${(s.improvement.fitScoreDelta * 100).toFixed(0)}%</td>
            <td>
              <span class="winner-badge winner-${s.winner}">${s.winner}</span>
            </td>
          </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Recommendations</h2>
      <ul class="recommendations">
        ${report.recommendations.map((r) => `<li>${r}</li>`).join('')}
      </ul>
    </div>

    <div class="footer">
      <p>Babylon RL Training Pipeline | Benchmark Suite v1.0</p>
    </div>
  </div>
</body>
</html>
`;

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, html);
    logger.info('HTML report generated', { outputPath });
  }

  /**
   * Generate JSON report
   */
  static async generateJson(
    report: FullBenchmarkReport,
    outputPath: string
  ): Promise<void> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
    logger.info('JSON report generated', { outputPath });
  }

  /**
   * Generate terminal-friendly text summary
   */
  static generateTextSummary(report: FullBenchmarkReport): string {
    const lines: string[] = [];

    lines.push('');
    lines.push(
      '═══════════════════════════════════════════════════════════════'
    );
    lines.push('                    BENCHMARK REPORT SUMMARY');
    lines.push(
      '═══════════════════════════════════════════════════════════════'
    );
    lines.push('');
    lines.push(`Model: ${report.modelVersion}`);
    lines.push(`Baseline: ${report.baselineDescription}`);
    lines.push(`Generated: ${new Date(report.generatedAt).toLocaleString()}`);
    lines.push('');

    // Verdict
    const verdictEmoji =
      report.summary.overallVerdict === 'deploy'
        ? '✅'
        : report.summary.overallVerdict === 'regression'
          ? '❌'
          : '🔄';
    lines.push(
      `${verdictEmoji} VERDICT: ${report.summary.overallVerdict.toUpperCase()}`
    );
    lines.push(report.summary.verdictExplanation);
    lines.push('');

    // Stats
    lines.push('📊 SUMMARY');
    lines.push(
      '───────────────────────────────────────────────────────────────'
    );
    lines.push(
      `Scenarios Won:        ${report.summary.scenariosWon}/${report.scenarios.length}`
    );
    lines.push(
      `Total Alpha:          ${formatCurrency(report.summary.totalAlpha)}`
    );
    lines.push(
      `Avg P&L Improvement:  ${report.summary.avgPnlImprovement >= 0 ? '+' : ''}${report.summary.avgPnlImprovement.toFixed(2)}%`
    );
    lines.push(
      `Avg Fit Score Change: ${report.summary.avgFitScoreImprovement >= 0 ? '+' : ''}${(report.summary.avgFitScoreImprovement * 100).toFixed(1)}%`
    );
    lines.push('');

    // Scenario table
    lines.push('🎯 SCENARIOS');
    lines.push(
      '───────────────────────────────────────────────────────────────'
    );
    lines.push(
      'Scenario             | Base P&L | Chal P&L | Alpha    | Winner'
    );
    lines.push(
      '─────────────────────|──────────|──────────|──────────|────────'
    );

    for (const s of report.scenarios) {
      const name = s.scenarioName.padEnd(20).slice(0, 20);
      const basePnl = `${formatCurrency(s.baseline.pnl, 0)}`.padStart(8);
      const chalPnl = `${formatCurrency(s.challenger.pnl, 0)}`.padStart(8);
      const alpha = `${formatCurrency(s.alphaGenerated, 0)}`.padStart(8);
      const winner = s.winner.padEnd(8);
      lines.push(`${name} | ${basePnl} | ${chalPnl} | ${alpha} | ${winner}`);
    }
    lines.push('');

    // Recommendations
    lines.push('💡 RECOMMENDATIONS');
    lines.push(
      '───────────────────────────────────────────────────────────────'
    );
    for (const rec of report.recommendations) {
      lines.push(`• ${rec}`);
    }
    lines.push('');
    lines.push(
      '═══════════════════════════════════════════════════════════════'
    );

    return lines.join('\n');
  }

  /**
   * Save all report formats
   *
   * @param report - The benchmark report to save
   * @param outputDir - Directory to write report files
   * @param printToConsole - Whether to print text summary to console (default: true for CLI usage)
   */
  static async saveAllFormats(
    report: FullBenchmarkReport,
    outputDir: string,
    printToConsole: boolean = true
  ): Promise<{ html: string; json: string; text: string }> {
    await fs.mkdir(outputDir, { recursive: true });

    const htmlPath = path.join(outputDir, 'report.html');
    const jsonPath = path.join(outputDir, 'report.json');
    const textPath = path.join(outputDir, 'report.txt');

    await this.generateHtml(report, htmlPath);
    await this.generateJson(report, jsonPath);

    const textContent = this.generateTextSummary(report);
    await fs.writeFile(textPath, textContent);

    // Print to console if requested (default for CLI usage)
    if (printToConsole) {
      console.log(textContent);
    }

    return { html: htmlPath, json: jsonPath, text: textPath };
  }
}
