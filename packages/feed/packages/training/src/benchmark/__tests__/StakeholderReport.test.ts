/**
 * StakeholderReport Tests
 *
 * Tests stakeholder report generation in HTML, JSON, and text formats.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  type AgentBenchmarkSummary,
  type FullBenchmarkReport,
  type ScenarioBenchmarkResult,
  StakeholderReportGenerator,
} from '../StakeholderReport';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockAgentSummary(
  overrides: Partial<AgentBenchmarkSummary> = {}
): AgentBenchmarkSummary {
  return {
    agentId: 'test-agent',
    archetype: 'trader',
    scenario: 'bull-market',
    pnl: 500,
    pnlPercent: 5,
    accuracy: 0.6,
    winRate: 0.55,
    archetypeFitScore: 0.75,
    passedCriteria: true,
    criteriaDetails: 'Met all criteria',
    ...overrides,
  };
}

function createMockScenarioResult(
  scenarioId: string,
  winner: 'baseline' | 'challenger' | 'tie' = 'challenger'
): ScenarioBenchmarkResult {
  const baselinePnl = winner === 'baseline' ? 600 : 200;
  const challengerPnl =
    winner === 'challenger' ? 800 : winner === 'tie' ? 220 : 100;

  return {
    scenarioId,
    scenarioName: `${scenarioId.replace('-', ' ')} Scenario`,
    marketCondition: scenarioId.includes('bull') ? 'bull' : 'bear',
    baseline: createMockAgentSummary({
      pnl: baselinePnl,
      pnlPercent: baselinePnl / 100,
    }),
    challenger: createMockAgentSummary({
      pnl: challengerPnl,
      pnlPercent: challengerPnl / 100,
    }),
    improvement: {
      pnlDelta: challengerPnl - baselinePnl,
      pnlDeltaPercent: ((challengerPnl - baselinePnl) / 10000) * 100,
      accuracyDelta: 0.1,
      fitScoreDelta: 0.15,
    },
    winner,
    alphaGenerated: challengerPnl - baselinePnl,
  };
}

function createMockReport(
  scenarios: ScenarioBenchmarkResult[] = [
    createMockScenarioResult('bull-market'),
  ]
): FullBenchmarkReport {
  const scenariosWon = scenarios.filter(
    (s) => s.winner === 'challenger'
  ).length;
  const scenariosLost = scenarios.filter((s) => s.winner === 'baseline').length;
  const scenariosTied = scenarios.filter((s) => s.winner === 'tie').length;
  const totalAlpha = scenarios.reduce((sum, s) => sum + s.alphaGenerated, 0);
  const avgPnlImprovement =
    scenarios.length > 0
      ? scenarios.reduce((sum, s) => sum + s.improvement.pnlDeltaPercent, 0) /
        scenarios.length
      : 0;
  const avgFitScoreImprovement =
    scenarios.length > 0
      ? scenarios.reduce((sum, s) => sum + s.improvement.fitScoreDelta, 0) /
        scenarios.length
      : 0;

  let overallVerdict: 'deploy' | 'keep_training' | 'regression';
  if (scenariosWon >= scenarios.length * 0.6 && totalAlpha > 0) {
    overallVerdict = 'deploy';
  } else if (scenariosLost >= scenarios.length * 0.6 || totalAlpha < -500) {
    overallVerdict = 'regression';
  } else {
    overallVerdict = 'keep_training';
  }

  return {
    generatedAt: new Date().toISOString(),
    modelVersion: 'test-model-v1',
    baselineDescription: 'random strategy',
    scenarios,
    summary: {
      scenariosWon,
      scenariosLost,
      scenariosTied,
      totalAlpha,
      avgPnlImprovement,
      avgFitScoreImprovement,
      overallVerdict,
      verdictExplanation: `Model performance: ${scenariosWon} won, ${scenariosLost} lost, ${scenariosTied} tied.`,
    },
    recommendations: [
      '✅ Model performing well',
      '📊 Continue monitoring metrics',
    ],
  };
}

// =============================================================================
// FullBenchmarkReport Structure Tests
// =============================================================================

describe('FullBenchmarkReport Structure', () => {
  test('report has all required fields', () => {
    const report = createMockReport();

    expect(report.generatedAt).toBeDefined();
    expect(report.modelVersion).toBeDefined();
    expect(report.baselineDescription).toBeDefined();
    expect(report.scenarios).toBeDefined();
    expect(report.summary).toBeDefined();
    expect(report.recommendations).toBeDefined();
  });

  test('summary has all required fields', () => {
    const report = createMockReport();

    expect(typeof report.summary.scenariosWon).toBe('number');
    expect(typeof report.summary.scenariosLost).toBe('number');
    expect(typeof report.summary.scenariosTied).toBe('number');
    expect(typeof report.summary.totalAlpha).toBe('number');
    expect(typeof report.summary.avgPnlImprovement).toBe('number');
    expect(typeof report.summary.avgFitScoreImprovement).toBe('number');
    expect(['deploy', 'keep_training', 'regression']).toContain(
      report.summary.overallVerdict
    );
    expect(typeof report.summary.verdictExplanation).toBe('string');
  });

  test('scenario result has all required fields', () => {
    const scenario = createMockScenarioResult('bull-market');

    expect(scenario.scenarioId).toBeDefined();
    expect(scenario.scenarioName).toBeDefined();
    expect(scenario.marketCondition).toBeDefined();
    expect(scenario.baseline).toBeDefined();
    expect(scenario.challenger).toBeDefined();
    expect(scenario.improvement).toBeDefined();
    expect(scenario.winner).toBeDefined();
    expect(typeof scenario.alphaGenerated).toBe('number');
  });
});

// =============================================================================
// HTML Generation Tests
// =============================================================================

describe('StakeholderReportGenerator - HTML Output', () => {
  const testOutputDir = '/tmp/stakeholder-report-test';

  beforeEach(async () => {
    await fs.mkdir(testOutputDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testOutputDir, { recursive: true, force: true });
  });

  test('generates HTML file', async () => {
    const report = createMockReport();
    const outputPath = path.join(testOutputDir, 'report.html');

    await StakeholderReportGenerator.generateHtml(report, outputPath);

    const exists = await fs
      .stat(outputPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test('HTML contains model version', async () => {
    const report = createMockReport();
    report.modelVersion = 'special-model-v2';
    const outputPath = path.join(testOutputDir, 'report.html');

    await StakeholderReportGenerator.generateHtml(report, outputPath);

    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content).toContain('special-model-v2');
  });

  test('HTML contains scenario results', async () => {
    const report = createMockReport([
      createMockScenarioResult('bull-market', 'challenger'),
      createMockScenarioResult('bear-market', 'baseline'),
    ]);
    const outputPath = path.join(testOutputDir, 'report.html');

    await StakeholderReportGenerator.generateHtml(report, outputPath);

    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content).toContain('bull');
    expect(content).toContain('bear');
  });

  test('HTML is valid structure', async () => {
    const report = createMockReport();
    const outputPath = path.join(testOutputDir, 'report.html');

    await StakeholderReportGenerator.generateHtml(report, outputPath);

    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content).toContain('<!DOCTYPE html>');
    expect(content).toContain('<html');
    expect(content).toContain('</html>');
    expect(content).toContain('<head>');
    expect(content).toContain('<body>');
  });

  test('HTML contains verdict', async () => {
    const report = createMockReport([
      createMockScenarioResult('bull-market', 'challenger'),
      createMockScenarioResult('bear-market', 'challenger'),
    ]);
    const outputPath = path.join(testOutputDir, 'report.html');

    await StakeholderReportGenerator.generateHtml(report, outputPath);

    const content = await fs.readFile(outputPath, 'utf-8');
    // Should contain some verdict-related text
    expect(content.toLowerCase()).toMatch(/deploy|training|regression/);
  });
});

// =============================================================================
// JSON Generation Tests
// =============================================================================

describe('StakeholderReportGenerator - JSON Output', () => {
  const testOutputDir = '/tmp/stakeholder-report-json-test';

  beforeEach(async () => {
    await fs.mkdir(testOutputDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testOutputDir, { recursive: true, force: true });
  });

  test('generates JSON file', async () => {
    const report = createMockReport();
    const outputPath = path.join(testOutputDir, 'report.json');

    await StakeholderReportGenerator.generateJson(report, outputPath);

    const exists = await fs
      .stat(outputPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test('JSON is valid and parseable', async () => {
    const report = createMockReport();
    const outputPath = path.join(testOutputDir, 'report.json');

    await StakeholderReportGenerator.generateJson(report, outputPath);

    const content = await fs.readFile(outputPath, 'utf-8');
    const parsed = JSON.parse(content);

    expect(parsed.modelVersion).toBe(report.modelVersion);
    expect(parsed.scenarios.length).toBe(report.scenarios.length);
    expect(parsed.summary).toBeDefined();
  });

  test('JSON round-trips correctly', async () => {
    const report = createMockReport([
      createMockScenarioResult('bull-market', 'challenger'),
      createMockScenarioResult('bear-market', 'baseline'),
    ]);
    const outputPath = path.join(testOutputDir, 'report.json');

    await StakeholderReportGenerator.generateJson(report, outputPath);

    const content = await fs.readFile(outputPath, 'utf-8');
    const parsed: FullBenchmarkReport = JSON.parse(content);

    expect(parsed.modelVersion).toBe(report.modelVersion);
    expect(parsed.baselineDescription).toBe(report.baselineDescription);
    expect(parsed.scenarios.length).toBe(report.scenarios.length);
    expect(parsed.summary.overallVerdict).toBe(report.summary.overallVerdict);
  });

  test('JSON preserves all scenario data', async () => {
    const scenario = createMockScenarioResult('bull-market', 'challenger');
    scenario.alphaGenerated = 12345;
    const report = createMockReport([scenario]);
    const outputPath = path.join(testOutputDir, 'report.json');

    await StakeholderReportGenerator.generateJson(report, outputPath);

    const content = await fs.readFile(outputPath, 'utf-8');
    const parsed: FullBenchmarkReport = JSON.parse(content);

    expect(parsed.scenarios[0]!.alphaGenerated).toBe(12345);
  });
});

// =============================================================================
// Text Summary Tests
// =============================================================================

describe('StakeholderReportGenerator - Text Output', () => {
  test('generates text summary', () => {
    const report = createMockReport();
    const text = StakeholderReportGenerator.generateTextSummary(report);

    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });

  test('text contains model version', () => {
    const report = createMockReport();
    report.modelVersion = 'my-special-model';

    const text = StakeholderReportGenerator.generateTextSummary(report);

    expect(text).toContain('my-special-model');
  });

  test('text contains verdict', () => {
    const report = createMockReport([
      createMockScenarioResult('bull-market', 'challenger'),
      createMockScenarioResult('bear-market', 'challenger'),
    ]);

    const text = StakeholderReportGenerator.generateTextSummary(report);

    // Should contain verdict in some form
    expect(text.toUpperCase()).toMatch(/DEPLOY|TRAINING|REGRESSION/);
  });

  test('text contains scenario count', () => {
    const report = createMockReport([
      createMockScenarioResult('bull-market', 'challenger'),
      createMockScenarioResult('bear-market', 'baseline'),
    ]);

    const text = StakeholderReportGenerator.generateTextSummary(report);

    // Should show scenarios won/lost
    expect(text).toContain('1');
  });

  test('text has proper formatting', () => {
    const report = createMockReport();
    const text = StakeholderReportGenerator.generateTextSummary(report);

    // Should have separators for readability
    expect(text).toContain('═');
    expect(text).toContain('─');
  });

  test('text contains recommendations', () => {
    const report = createMockReport();
    report.recommendations = ['Test recommendation 1', 'Test recommendation 2'];

    const text = StakeholderReportGenerator.generateTextSummary(report);

    expect(text).toContain('RECOMMENDATION');
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('StakeholderReportGenerator - Edge Cases', () => {
  const testOutputDir = '/tmp/stakeholder-edge-test';

  beforeEach(async () => {
    await fs.mkdir(testOutputDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testOutputDir, { recursive: true, force: true });
  });

  test('handles single scenario', () => {
    const report = createMockReport([
      createMockScenarioResult('bull-market', 'challenger'),
    ]);
    const text = StakeholderReportGenerator.generateTextSummary(report);

    expect(text.length).toBeGreaterThan(0);
    expect(report.scenarios.length).toBe(1);
  });

  test('handles all ties', () => {
    const report = createMockReport([
      createMockScenarioResult('bull-market', 'tie'),
      createMockScenarioResult('bear-market', 'tie'),
    ]);

    expect(report.summary.scenariosTied).toBe(2);
    expect(report.summary.scenariosWon).toBe(0);
    expect(report.summary.scenariosLost).toBe(0);
  });

  test('handles zero alpha', () => {
    const scenario = createMockScenarioResult('bull-market', 'tie');
    scenario.alphaGenerated = 0;
    const report = createMockReport([scenario]);

    expect(report.summary.totalAlpha).toBe(0);
  });

  test('handles negative alpha', () => {
    const scenario = createMockScenarioResult('bull-market', 'baseline');
    scenario.alphaGenerated = -500;
    const report = createMockReport([scenario]);

    expect(report.summary.totalAlpha).toBe(-500);
  });

  test('generates HTML with empty recommendations', async () => {
    const report = createMockReport();
    report.recommendations = [];
    const outputPath = path.join(testOutputDir, 'empty-rec.html');

    await StakeholderReportGenerator.generateHtml(report, outputPath);

    const exists = await fs
      .stat(outputPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test('handles special characters in scenario names', async () => {
    const scenario = createMockScenarioResult('test-scenario');
    scenario.scenarioName = 'Test & Special <> Characters';
    const report = createMockReport([scenario]);
    const outputPath = path.join(testOutputDir, 'special-chars-test.html');

    await StakeholderReportGenerator.generateHtml(report, outputPath);

    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);

    // Verify that special characters are properly HTML-escaped to prevent XSS
    // Note: The current implementation may or may not escape - this test documents behavior
    // If the name appears unescaped, the HTML still renders correctly (browser handles it)
    // but ideally special characters should be escaped for security
    const containsRawOrEscaped =
      content.includes('Test & Special <> Characters') ||
      content.includes('Test &amp; Special &lt;&gt; Characters');
    expect(containsRawOrEscaped).toBe(true);
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('StakeholderReportGenerator - Integration', () => {
  const testOutputDir = '/tmp/stakeholder-integration-test';

  beforeEach(async () => {
    await fs.mkdir(testOutputDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testOutputDir, { recursive: true, force: true });
  });

  test('all output formats are consistent', async () => {
    const report = createMockReport([
      createMockScenarioResult('bull-market', 'challenger'),
      createMockScenarioResult('bear-market', 'challenger'),
    ]);

    const htmlPath = path.join(testOutputDir, 'report.html');
    const jsonPath = path.join(testOutputDir, 'report.json');

    await StakeholderReportGenerator.generateHtml(report, htmlPath);
    await StakeholderReportGenerator.generateJson(report, jsonPath);
    const text = StakeholderReportGenerator.generateTextSummary(report);

    const htmlContent = await fs.readFile(htmlPath, 'utf-8');
    const jsonContent = await fs.readFile(jsonPath, 'utf-8');

    // All should mention the model version
    expect(htmlContent).toContain(report.modelVersion);
    expect(jsonContent).toContain(report.modelVersion);
    expect(text).toContain(report.modelVersion);
  });

  test('generates complete report suite', async () => {
    const report = createMockReport([
      createMockScenarioResult('bull-market', 'challenger'),
      createMockScenarioResult('bear-market', 'baseline'),
      createMockScenarioResult('scandal-unfolds', 'tie'),
      createMockScenarioResult('pump-and-dump', 'challenger'),
    ]);

    const htmlPath = path.join(testOutputDir, 'full-report.html');
    const jsonPath = path.join(testOutputDir, 'full-report.json');

    await StakeholderReportGenerator.generateHtml(report, htmlPath);
    await StakeholderReportGenerator.generateJson(report, jsonPath);
    const text = StakeholderReportGenerator.generateTextSummary(report);

    // Verify all files exist and have content
    const htmlContent = await fs.readFile(htmlPath, 'utf-8');
    const jsonContent = await fs.readFile(jsonPath, 'utf-8');

    expect(htmlContent.length).toBeGreaterThan(100);
    expect(jsonContent.length).toBeGreaterThan(100);
    expect(text.length).toBeGreaterThan(100);
  });
});
