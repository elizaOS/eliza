import fs from 'fs/promises';
import path from 'path';
// import { logger } from '@elizaos/core';
import type { ScenarioResult, ScenarioRunOptions } from '../../scenario-runner/types.js';

export function displayScenarioResults(
  results: ScenarioResult[],
  options: ScenarioRunOptions
): void {
  console.log('\n📊 Scenario Test Results');
  console.log('='.repeat(50));

  for (const result of results) {
    displaySingleResult(result, options);
  }

  displaySummary(results, options);
}

function displaySingleResult(result: ScenarioResult, options: ScenarioRunOptions): void {
  const status = result.passed ? '✅ PASS' : '❌ FAIL';
  const duration = (result.duration / 1000).toFixed(2);

  console.log(`\n${status} ${result.name} (${duration}s)`);

  if (options.verbose) {
    console.log(`  ID: ${result.scenarioId}`);
    console.log(`  Messages: ${result.metrics.messageCount}`);
    console.log(
      `  Actions: ${Object.values(result.metrics.actionCounts).reduce((sum, count) => sum + count, 0)}`
    );
    console.log(`  Tokens: ${result.metrics.tokenUsage.total}`);

    if (result.score !== undefined) {
      console.log(`  Score: ${(result.score * 100).toFixed(1)}%`);
    }
  }

  // Display verification results
  if (result.verificationResults.length > 0) {
    console.log('  Verification Results:');
    for (const verification of result.verificationResults) {
      const verifyStatus = verification.passed ? '✓' : '✗';
      console.log(`    ${verifyStatus} ${verification.ruleName}`);

      if (options.verbose && verification.reason) {
        console.log(`      ${verification.reason}`);
      }
    }
  }

  // Display errors if any
  if (result.errors && result.errors.length > 0) {
    console.log('  Errors:');
    for (const error of result.errors) {
      console.log(`    ❌ ${error}`);
    }
  }

  // Display warnings if any
  if (result.warnings && result.warnings.length > 0) {
    console.log('  Warnings:');
    for (const warning of result.warnings) {
      console.log(`    ⚠️  ${warning}`);
    }
  }
}

function displaySummary(results: ScenarioResult[], options: ScenarioRunOptions): void {
  console.log('\n📈 Summary');
  console.log('-'.repeat(30));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
  const avgDuration = totalDuration / results.length;

  console.log(`Total Scenarios: ${results.length}`);
  console.log(`Passed: ${passed} (${((passed / results.length) * 100).toFixed(1)}%)`);
  console.log(`Failed: ${failed} (${((failed / results.length) * 100).toFixed(1)}%)`);
  console.log(`Average Duration: ${(avgDuration / 1000).toFixed(2)}s`);
  console.log(`Total Duration: ${(totalDuration / 1000).toFixed(2)}s`);

  if (options.benchmark) {
    displayBenchmarkSummary(results);
  }
}

function displayBenchmarkSummary(results: ScenarioResult[]): void {
  console.log('\n🏆 Benchmark Metrics');
  console.log('-'.repeat(30));

  const totalTokens = results.reduce((sum, r) => sum + r.metrics.tokenUsage.total, 0);
  const totalMessages = results.reduce((sum, r) => sum + r.metrics.messageCount, 0);
  const avgLatency =
    results.reduce((sum, r) => sum + r.metrics.responseLatency.average, 0) / results.length;

  console.log(`Total Tokens Used: ${totalTokens.toLocaleString()}`);
  console.log(`Total Messages: ${totalMessages.toLocaleString()}`);
  console.log(`Average Response Latency: ${avgLatency.toFixed(0)}ms`);

  // Display top performing scenarios
  const sortedByScore = results
    .filter((r) => r.score !== undefined)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 3);

  if (sortedByScore.length > 0) {
    console.log('\n🥇 Top Performing Scenarios:');
    sortedByScore.forEach((result, index) => {
      const medal = ['🥇', '🥈', '🥉'][index] || '🏅';
      console.log(`  ${medal} ${result.name}: ${((result.score || 0) * 100).toFixed(1)}%`);
    });
  }
}

export async function saveResults(
  results: ScenarioResult[],
  outputPath: string,
  format: 'json' | 'text' | 'html'
): Promise<void> {
  const dir = path.dirname(outputPath);
  await fs.mkdir(dir, { recursive: true });

  switch (format) {
    case 'json':
      await saveJsonResults(results, outputPath);
      break;
    case 'html':
      await saveHtmlResults(results, outputPath);
      break;
    case 'text':
    default:
      await saveTextResults(results, outputPath);
      break;
  }
}

async function saveJsonResults(results: ScenarioResult[], outputPath: string): Promise<void> {
  const reportData = {
    timestamp: new Date().toISOString(),
    summary: {
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      totalDuration: results.reduce((sum, r) => sum + r.duration, 0),
    },
    results,
  };

  await fs.writeFile(outputPath, JSON.stringify(reportData, null, 2));
}

async function saveTextResults(results: ScenarioResult[], outputPath: string): Promise<void> {
  const lines: string[] = [];

  lines.push('Scenario Test Results');
  lines.push('='.repeat(50));
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  for (const result of results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    const duration = (result.duration / 1000).toFixed(2);

    lines.push(`[${status}] ${result.name} (${duration}s)`);
    lines.push(`  ID: ${result.scenarioId}`);
    lines.push(`  Messages: ${result.metrics.messageCount}`);
    lines.push(`  Tokens: ${result.metrics.tokenUsage.total}`);

    if (result.verificationResults.length > 0) {
      lines.push('  Verification Results:');
      for (const verification of result.verificationResults) {
        const verifyStatus = verification.passed ? '✓' : '✗';
        lines.push(`    ${verifyStatus} ${verification.ruleName}: ${verification.reason}`);
      }
    }

    if (result.errors && result.errors.length > 0) {
      lines.push('  Errors:');
      result.errors.forEach((error) => lines.push(`    - ${error}`));
    }

    lines.push('');
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  lines.push('Summary');
  lines.push('-'.repeat(30));
  lines.push(`Total: ${results.length}`);
  lines.push(`Passed: ${passed} (${((passed / results.length) * 100).toFixed(1)}%)`);
  lines.push(`Failed: ${failed} (${((failed / results.length) * 100).toFixed(1)}%)`);
  lines.push(`Total Duration: ${(totalDuration / 1000).toFixed(2)}s`);

  await fs.writeFile(outputPath, lines.join('\n'));
}

async function saveHtmlResults(results: ScenarioResult[], outputPath: string): Promise<void> {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Scenario Test Results</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { background: #f5f5f5; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
        .summary { display: flex; gap: 20px; margin-bottom: 30px; }
        .metric { background: white; padding: 15px; border-radius: 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); text-align: center; }
        .metric h3 { margin: 0 0 10px 0; color: #333; }
        .metric .value { font-size: 24px; font-weight: bold; }
        .passed { color: #28a745; }
        .failed { color: #dc3545; }
        .result { background: white; margin-bottom: 15px; padding: 15px; border-radius: 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .result-header { display: flex; justify-content: between; align-items: center; margin-bottom: 10px; }
        .status-pass { color: #28a745; font-weight: bold; }
        .status-fail { color: #dc3545; font-weight: bold; }
        .verification { margin-left: 20px; font-size: 14px; }
        .verification-pass { color: #28a745; }
        .verification-fail { color: #dc3545; }
    </style>
</head>
<body>
    <div class="header">
        <h1>📊 Scenario Test Results</h1>
        <p>Generated: ${new Date().toISOString()}</p>
    </div>

    <div class="summary">
        <div class="metric">
            <h3>Total Scenarios</h3>
            <div class="value">${results.length}</div>
        </div>
        <div class="metric">
            <h3>Passed</h3>
            <div class="value passed">${passed}</div>
        </div>
        <div class="metric">
            <h3>Failed</h3>
            <div class="value failed">${failed}</div>
        </div>
        <div class="metric">
            <h3>Success Rate</h3>
            <div class="value">${((passed / results.length) * 100).toFixed(1)}%</div>
        </div>
        <div class="metric">
            <h3>Total Duration</h3>
            <div class="value">${(totalDuration / 1000).toFixed(2)}s</div>
        </div>
    </div>

    <div class="results">
        ${results
          .map(
            (result) => `
            <div class="result">
                <div class="result-header">
                    <h3>${result.name}</h3>
                    <span class="${result.passed ? 'status-pass' : 'status-fail'}">
                        ${result.passed ? '✅ PASS' : '❌ FAIL'}
                    </span>
                </div>
                <p><strong>Duration:</strong> ${(result.duration / 1000).toFixed(2)}s</p>
                <p><strong>Messages:</strong> ${result.metrics.messageCount}</p>
                <p><strong>Tokens:</strong> ${result.metrics.tokenUsage.total}</p>
                
                ${
                  result.verificationResults.length > 0
                    ? `
                    <h4>Verification Results:</h4>
                    ${result.verificationResults
                      .map(
                        (verification) => `
                        <div class="verification">
                            <span class="${verification.passed ? 'verification-pass' : 'verification-fail'}">
                                ${verification.passed ? '✓' : '✗'} ${verification.ruleName}
                            </span>
                            <br><small>${verification.reason}</small>
                        </div>
                    `
                      )
                      .join('')}
                `
                    : ''
                }
                
                ${
                  result.errors && result.errors.length > 0
                    ? `
                    <h4>Errors:</h4>
                    <ul>
                        ${result.errors.map((error) => `<li class="verification-fail">${error}</li>`).join('')}
                    </ul>
                `
                    : ''
                }
            </div>
        `
          )
          .join('')}
    </div>
</body>
</html>`;

  await fs.writeFile(outputPath, html);
}
