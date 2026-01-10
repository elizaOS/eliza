#!/usr/bin/env tsx

/**
 * Comprehensive test runner for the todo plugin reminder service
 * This script runs all tests and generates detailed reports
 */

import { execSync } from 'child_process';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

interface TestSuite {
  name: string;
  description: string;
  command: string;
  timeout: number;
  required: boolean;
}

interface TestResult {
  suite: string;
  passed: boolean;
  duration: number;
  output: string;
  error?: string;
  coverage?: {
    statements: number;
    branches: number;
    functions: number;
    lines: number;
  };
}

const TEST_SUITES: TestSuite[] = [
  {
    name: 'Unit Tests',
    description: 'Core reminder service unit tests with mocks',
    command: 'vitest run src/tests/reminderService.unit.test.ts --coverage',
    timeout: 30000,
    required: true,
  },
  {
    name: 'Rolodex Integration',
    description: 'Integration tests with rolodex plugin for cross-platform messaging',
    command: 'vitest run src/tests/rolodexIntegration.test.ts --coverage',
    timeout: 45000,
    required: true,
  },
  {
    name: 'Task Integration',
    description: 'Integration tests with plugin-task for confirmation workflows',
    command: 'vitest run src/tests/taskIntegration.test.ts --coverage',
    timeout: 45000,
    required: true,
  },
  {
    name: 'Queue Management',
    description: 'Comprehensive tests for reminder queue processing and task completion',
    command: 'vitest run src/tests/reminderQueue.test.ts --coverage',
    timeout: 60000,
    required: true,
  },
  {
    name: 'E2E Tests',
    description: 'End-to-end integration tests with real plugin instances',
    command: 'vitest run src/__tests__/e2e/ --coverage',
    timeout: 120000,
    required: false,
  },
];

class TestRunner {
  private results: TestResult[] = [];
  private startTime: number = 0;
  private outputDir: string;

  constructor() {
    this.outputDir = path.join(process.cwd(), 'test-results');
    this.ensureOutputDir();
  }

  private ensureOutputDir(): void {
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }
  }

  async runAllTests(): Promise<void> {
    console.log('🚀 Starting comprehensive todo plugin reminder service tests...\n');
    this.startTime = Date.now();

    // Run each test suite
    for (const suite of TEST_SUITES) {
      await this.runTestSuite(suite);
    }

    // Generate reports
    this.generateSummaryReport();
    this.generateDetailedReport();
    this.generateCoverageReport();

    // Exit with appropriate code
    const failedRequired = this.results.filter(
      (r) => !r.passed && TEST_SUITES.find((s) => s.name === r.suite)?.required
    );

    if (failedRequired.length > 0) {
      console.log(`\n❌ ${failedRequired.length} required test suite(s) failed`);
      process.exit(1);
    } else {
      console.log('\n✅ All required tests passed!');
      process.exit(0);
    }
  }

  private async runTestSuite(suite: TestSuite): Promise<void> {
    console.log(`📋 Running ${suite.name}: ${suite.description}`);

    const startTime = Date.now();
    let result: TestResult = {
      suite: suite.name,
      passed: false,
      duration: 0,
      output: '',
    };

    try {
      // Run the test command
      const output = execSync(suite.command, {
        encoding: 'utf8',
        timeout: suite.timeout,
        cwd: process.cwd(),
      });

      result.output = output;
      result.passed = true;
      result.duration = Date.now() - startTime;

      // Extract coverage information if available
      result.coverage = this.extractCoverage(output);

      console.log(`   ✅ Passed (${result.duration}ms)`);
    } catch (error: any) {
      result.passed = false;
      result.duration = Date.now() - startTime;
      result.error = error.message;
      result.output = error.stdout || error.stderr || '';

      if (suite.required) {
        console.log(`   ❌ Failed (${result.duration}ms): ${error.message}`);
      } else {
        console.log(`   ⚠️  Failed (optional) (${result.duration}ms): ${error.message}`);
      }
    }

    this.results.push(result);
    console.log(''); // Empty line for readability
  }

  private extractCoverage(output: string): TestResult['coverage'] | undefined {
    // Look for coverage percentages in the output
    const coverageRegex =
      /Statements\s*:\s*(\d+\.?\d*)%.*Branches\s*:\s*(\d+\.?\d*)%.*Functions\s*:\s*(\d+\.?\d*)%.*Lines\s*:\s*(\d+\.?\d*)%/s;
    const match = output.match(coverageRegex);

    if (match) {
      return {
        statements: parseFloat(match[1]),
        branches: parseFloat(match[2]),
        functions: parseFloat(match[3]),
        lines: parseFloat(match[4]),
      };
    }

    return undefined;
  }

  private generateSummaryReport(): void {
    const totalDuration = Date.now() - this.startTime;
    const passed = this.results.filter((r) => r.passed).length;
    const failed = this.results.filter((r) => !r.passed).length;
    const requiredFailed = this.results.filter(
      (r) => !r.passed && TEST_SUITES.find((s) => s.name === r.suite)?.required
    ).length;

    console.log('\n📊 Test Summary Report');
    console.log('========================');
    console.log(`Total Duration: ${totalDuration}ms`);
    console.log(`Test Suites: ${this.results.length}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`Required Failed: ${requiredFailed}`);
    console.log('');

    // Coverage summary
    const coverageResults = this.results.filter((r) => r.coverage);
    if (coverageResults.length > 0) {
      const avgStatements =
        coverageResults.reduce((sum, r) => sum + r.coverage!.statements, 0) /
        coverageResults.length;
      const avgBranches =
        coverageResults.reduce((sum, r) => sum + r.coverage!.branches, 0) / coverageResults.length;
      const avgFunctions =
        coverageResults.reduce((sum, r) => sum + r.coverage!.functions, 0) / coverageResults.length;
      const avgLines =
        coverageResults.reduce((sum, r) => sum + r.coverage!.lines, 0) / coverageResults.length;

      console.log('📈 Coverage Summary');
      console.log('===================');
      console.log(`Statements: ${avgStatements.toFixed(2)}%`);
      console.log(`Branches: ${avgBranches.toFixed(2)}%`);
      console.log(`Functions: ${avgFunctions.toFixed(2)}%`);
      console.log(`Lines: ${avgLines.toFixed(2)}%`);
      console.log('');
    }

    // Individual results
    console.log('📋 Individual Results');
    console.log('=====================');
    for (const result of this.results) {
      const status = result.passed ? '✅' : '❌';
      const required = TEST_SUITES.find((s) => s.name === result.suite)?.required
        ? ''
        : ' (optional)';
      console.log(`${status} ${result.suite}${required}: ${result.duration}ms`);

      if (result.coverage) {
        console.log(
          `   Coverage: ${result.coverage.statements}% statements, ${result.coverage.lines}% lines`
        );
      }

      if (!result.passed && result.error) {
        console.log(`   Error: ${result.error.split('\n')[0]}`);
      }
    }
  }

  private generateDetailedReport(): void {
    const reportPath = path.join(this.outputDir, 'detailed-report.json');
    const report = {
      timestamp: new Date().toISOString(),
      totalDuration: Date.now() - this.startTime,
      summary: {
        total: this.results.length,
        passed: this.results.filter((r) => r.passed).length,
        failed: this.results.filter((r) => !r.passed).length,
        requiredFailed: this.results.filter(
          (r) => !r.passed && TEST_SUITES.find((s) => s.name === r.suite)?.required
        ).length,
      },
      results: this.results.map((result) => ({
        ...result,
        required: TEST_SUITES.find((s) => s.name === result.suite)?.required || false,
      })),
    };

    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n📄 Detailed report saved to: ${reportPath}`);
  }

  private generateCoverageReport(): void {
    const coverageResults = this.results.filter((r) => r.coverage);
    if (coverageResults.length === 0) return;

    const reportPath = path.join(this.outputDir, 'coverage-report.json');
    const report = {
      timestamp: new Date().toISOString(),
      overall: {
        statements:
          coverageResults.reduce((sum, r) => sum + r.coverage!.statements, 0) /
          coverageResults.length,
        branches:
          coverageResults.reduce((sum, r) => sum + r.coverage!.branches, 0) /
          coverageResults.length,
        functions:
          coverageResults.reduce((sum, r) => sum + r.coverage!.functions, 0) /
          coverageResults.length,
        lines:
          coverageResults.reduce((sum, r) => sum + r.coverage!.lines, 0) / coverageResults.length,
      },
      bySuite: coverageResults.map((result) => ({
        suite: result.suite,
        coverage: result.coverage,
      })),
    };

    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`📊 Coverage report saved to: ${reportPath}`);
  }
}

// Run the tests if this script is executed directly
if (require.main === module) {
  const runner = new TestRunner();
  runner.runAllTests().catch((error) => {
    console.error('❌ Test runner failed:', error);
    process.exit(1);
  });
}

export { TestRunner };
