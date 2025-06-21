#!/usr/bin/env node
/**
 * UX Implementation Plan Test Runner
 * 
 * This script executes a comprehensive test plan for the plugin development workflow UX,
 * covering all phases, edge cases, and integration scenarios identified in the analysis.
 * 
 * Test Categories:
 * 1. Comprehensive Workflow - End-to-end plugin development process
 * 2. Discovery Edge Cases - Search ambiguity and error handling
 * 3. Secret Management Edge Cases - Configuration validation and security
 * 4. Publishing Conflicts - Name conflicts and validation failures
 * 5. Integration Stress Test - Performance under concurrent operations
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

interface TestPlan {
  phase: string;
  scenarios: Array<{
    name: string;
    file: string;
    description: string;
    expectedOutcome: string;
    criticalityLevel: 'high' | 'medium' | 'low';
  }>;
}

const UX_IMPLEMENTATION_PLAN: TestPlan[] = [
  {
    phase: 'Phase 1: Comprehensive Workflow Validation',
    scenarios: [
      {
        name: 'Comprehensive UX Workflow',
        file: 'comprehensive-ux-workflow.ts',
        description: 'Tests the complete plugin development workflow from discovery to publishing',
        expectedOutcome: 'All four phases (discovery, development, secrets, publishing) complete successfully with proper integration',
        criticalityLevel: 'high'
      }
    ]
  },
  {
    phase: 'Phase 2: Discovery Phase Edge Cases',
    scenarios: [
      {
        name: 'Edge Case Discovery',
        file: 'edge-case-discovery.ts',
        description: 'Tests edge cases in plugin discovery including vague queries and non-existent categories',
        expectedOutcome: 'Vague queries handled with clarification, non-existent searches provide alternatives',
        criticalityLevel: 'high'
      }
    ]
  },
  {
    phase: 'Phase 3: Secret Management Edge Cases',
    scenarios: [
      {
        name: 'Secret Management Edge Cases',
        file: 'secret-management-edge-cases.ts',
        description: 'Tests edge cases in secret collection, validation, and security concerns',
        expectedOutcome: 'Invalid formats rejected, security guidance provided, complex configurations supported',
        criticalityLevel: 'high'
      }
    ]
  },
  {
    phase: 'Phase 4: Publishing Conflict Resolution',
    scenarios: [
      {
        name: 'Publishing Conflicts',
        file: 'publishing-conflicts-scenario.ts',
        description: 'Tests name conflicts, version issues, and publishing validation failures',
        expectedOutcome: 'Conflicts identified and resolved, validation issues diagnosed, authentication problems fixed',
        criticalityLevel: 'high'
      }
    ]
  },
  {
    phase: 'Phase 5: Integration Stress Testing',
    scenarios: [
      {
        name: 'Integration Stress Test',
        file: 'integration-stress-test.ts',
        description: 'Tests system performance under concurrent operations and stress conditions',
        expectedOutcome: 'System maintains performance under load, handles concurrent operations, provides error recovery',
        criticalityLevel: 'medium'
      }
    ]
  }
];

class UXTestRunner {
  private resultsDir: string;
  private logFile: string;
  private startTime: number = Date.now();

  constructor() {
    this.resultsDir = path.join(process.cwd(), 'ux-test-results');
    this.logFile = path.join(this.resultsDir, `ux-test-run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    this.ensureResultsDirectory();
  }

  private ensureResultsDirectory(): void {
    if (!fs.existsSync(this.resultsDir)) {
      fs.mkdirSync(this.resultsDir, { recursive: true });
    }
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\\n`;
    console.log(message);
    fs.appendFileSync(this.logFile, logEntry);
  }

  private async runScenario(scenario: any): Promise<{
    success: boolean;
    duration: number;
    details: any;
  }> {
    const startTime = Date.now();
    const scenarioPath = path.join(__dirname, scenario.file);
    
    this.log(`\\n🧪 Running scenario: ${scenario.name}`);
    this.log(`📝 Description: ${scenario.description}`);
    this.log(`🎯 Expected: ${scenario.expectedOutcome}`);
    
    try {
      // Check if scenario file exists
      if (!fs.existsSync(scenarioPath)) {
        throw new Error(`Scenario file not found: ${scenarioPath}`);
      }

      // Run the scenario using the CLI scenario command
      const command = `npx elizaos scenario run --scenario "${scenarioPath}" --verbose --format json --output "${this.resultsDir}/result-${scenario.name.replace(/\\s+/g, '-').toLowerCase()}.json"`;
      
      this.log(`🔄 Executing: ${command}`);
      
      const output = execSync(command, {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 600000, // 10 minutes max per scenario
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer
      });

      const duration = Date.now() - startTime;
      
      this.log(`✅ Scenario completed successfully in ${(duration / 1000).toFixed(2)}s`);
      this.log(`📊 Output preview: ${output.substring(0, 200)}...`);

      return {
        success: true,
        duration,
        details: {
          output: output,
          exitCode: 0
        }
      };

    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorMessage = error.message || String(error);
      
      this.log(`❌ Scenario failed after ${(duration / 1000).toFixed(2)}s`);
      this.log(`💥 Error: ${errorMessage}`);
      
      if (error.stdout) {
        this.log(`📤 Stdout: ${error.stdout}`);
      }
      if (error.stderr) {
        this.log(`📥 Stderr: ${error.stderr}`);
      }

      return {
        success: false,
        duration,
        details: {
          error: errorMessage,
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.status
        }
      };
    }
  }

  private generateReport(results: any[]): void {
    const totalDuration = Date.now() - this.startTime;
    const totalScenarios = results.length;
    const passedScenarios = results.filter(r => r.success).length;
    const failedScenarios = totalScenarios - passedScenarios;
    const successRate = (passedScenarios / totalScenarios) * 100;

    const report = `
# UX Implementation Plan Test Results

## Summary
- **Total Scenarios**: ${totalScenarios}
- **Passed**: ${passedScenarios}
- **Failed**: ${failedScenarios}
- **Success Rate**: ${successRate.toFixed(1)}%
- **Total Duration**: ${(totalDuration / 1000 / 60).toFixed(2)} minutes

## Detailed Results

${results.map((result, index) => `
### ${index + 1}. ${result.scenario.name}
- **Status**: ${result.success ? '✅ PASSED' : '❌ FAILED'}
- **Duration**: ${(result.duration / 1000).toFixed(2)}s
- **Criticality**: ${result.scenario.criticalityLevel.toUpperCase()}
- **Expected**: ${result.scenario.expectedOutcome}
${result.success ? '' : `- **Error**: ${result.details.error}`}
`).join('')}

## Recommendations

${failedScenarios > 0 ? `
### Failed Scenarios Analysis
${results.filter(r => !r.success).map(r => `
- **${r.scenario.name}**: ${r.details.error}
  - Review scenario expectations and agent capabilities
  - Check plugin integration and service availability
  - Validate test environment configuration
`).join('')}
` : ''}

### Next Steps
${successRate >= 90 ? `
🎉 **Excellent Results!** The UX implementation is performing well across all test scenarios.
- Consider adding more edge cases for comprehensive coverage
- Monitor performance metrics for optimization opportunities
- Document successful patterns for future development
` : successRate >= 70 ? `
⚠️ **Good Results with Room for Improvement**
- Focus on failed scenarios to improve overall UX quality
- Review edge case handling and error recovery mechanisms
- Consider additional user guidance and clarification flows
` : `
🚨 **Significant Issues Detected**
- Critical UX flows are failing and require immediate attention
- Review plugin integration and service dependencies
- Consider simplifying complex workflows or adding more user guidance
- Validate that all required services and dependencies are properly configured
`}

## Test Environment
- **Node Version**: ${process.version}
- **Execution Time**: ${new Date().toISOString()}
- **Working Directory**: ${process.cwd()}
- **Results Directory**: ${this.resultsDir}

---
Generated by UX Implementation Plan Test Runner
`;

    const reportPath = path.join(this.resultsDir, 'ux-implementation-plan-report.md');
    fs.writeFileSync(reportPath, report);
    
    this.log(`\\n📊 Complete report saved to: ${reportPath}`);
    this.log(`\\n🎯 FINAL SUMMARY: ${passedScenarios}/${totalScenarios} scenarios passed (${successRate.toFixed(1)}% success rate)`);
  }

  async runImplementationPlan(): Promise<void> {
    this.log('🚀 Starting UX Implementation Plan Test Execution');
    this.log(`📂 Results will be saved to: ${this.resultsDir}`);
    this.log(`📝 Detailed log: ${this.logFile}`);

    const results = [];

    for (const phase of UX_IMPLEMENTATION_PLAN) {
      this.log(`\\n🔄 ${phase.phase}`);
      this.log('='.repeat(60));

      for (const scenario of phase.scenarios) {
        const result = await this.runScenario(scenario);
        results.push({
          phase: phase.phase,
          scenario,
          success: result.success,
          duration: result.duration,
          details: result.details
        });

        // Brief pause between scenarios to prevent resource conflicts
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    this.log('\\n🏁 All scenarios completed. Generating final report...');
    this.generateReport(results);
  }
}

// Execute the implementation plan if run directly
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Check if this file is being run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const runner = new UXTestRunner();
  runner.runImplementationPlan()
    .then(() => {
      console.log('\\n✅ UX Implementation Plan execution completed successfully!');
      process.exit(0);
    })
    .catch(error => {
      console.error('\\n❌ UX Implementation Plan execution failed:', error);
      process.exit(1);
    });
}

export { UXTestRunner, UX_IMPLEMENTATION_PLAN };