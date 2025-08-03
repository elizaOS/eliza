#!/usr/bin/env bun

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const EXAMPLES_DIR = path.join(__dirname, '..', 'src', 'commands', 'scenario', 'examples');

interface ScenarioResult {
    file: string;
    success: boolean;
    error?: string;
    duration: number;
    expectedFailure?: boolean;
}

async function runAllScenarios(): Promise<void> {
    console.log('🧪 Running all scenario tests...\n');

    // Get all .scenario.yaml files
    const scenarioFiles = fs.readdirSync(EXAMPLES_DIR)
        .filter(file => file.endsWith('.scenario.yaml'))
        .map(file => path.join(EXAMPLES_DIR, file));

    console.log(`Found ${scenarioFiles.length} scenario files:`);
    scenarioFiles.forEach(file => {
        console.log(`  - ${path.basename(file)}`);
    });
    console.log('');

    const results: ScenarioResult[] = [];
    let totalDuration = 0;
    let passed = 0;
    let failed = 0;
    let expectedFailures = 0;

    for (const scenarioFile of scenarioFiles) {
        const fileName = path.basename(scenarioFile);
        const isExpectedFailure = fileName.includes('invalid') || fileName.includes('missing');

        console.log(`\n🔍 Running: ${fileName}${isExpectedFailure ? ' (expected to fail)' : ''}`);

        const startTime = Date.now();
        let success = false;
        let error: string | undefined;

        try {
            // Run the scenario using the CLI
            const command = `bun run packages/cli/src/index.ts scenario run "${scenarioFile}"`;
            console.log(`  Command: ${command}`);

            execSync(command, {
                stdio: 'pipe',
                cwd: path.join(__dirname, '..', '..', '..'), // Root of monorepo
                timeout: 300000 // 5 minute timeout per scenario (for LLM calls and E2B)
            });

            success = true;
            if (isExpectedFailure) {
                console.log(`  ⚠️  UNEXPECTED SUCCESS (should have failed)`);
                failed++;
            } else {
                passed++;
            }
        } catch (err: any) {
            error = err.message || 'Unknown error';

            if (isExpectedFailure) {
                console.log(`  ✅ EXPECTED FAILURE (validation working correctly)`);
                expectedFailures++;
            } else {
                failed++;
            }
        }

        const duration = Date.now() - startTime;
        totalDuration += duration;

        results.push({
            file: fileName,
            success,
            error,
            duration,
            expectedFailure: isExpectedFailure
        });

        const status = success ? '✅ PASS' : (isExpectedFailure ? '✅ EXPECTED FAIL' : '❌ FAIL');
        console.log(`  ${status} (${duration}ms)`);

        if (error && !isExpectedFailure) {
            console.log(`  Error: ${error}`);
        }
    }

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total Scenarios: ${scenarioFiles.length}`);
    console.log(`Passed: ${passed} ✅`);
    console.log(`Failed: ${failed} ❌`);
    console.log(`Expected Failures: ${expectedFailures} ✅`);
    console.log(`Total Duration: ${totalDuration}ms`);
    console.log(`Average Duration: ${Math.round(totalDuration / scenarioFiles.length)}ms`);

    if (failed > 0) {
        console.log('\n❌ UNEXPECTED FAILURES:');
        results.filter(r => !r.success && !r.expectedFailure).forEach(result => {
            console.log(`  - ${result.file}: ${result.error}`);
        });
        process.exit(1);
    } else {
        console.log('\n🎉 All scenarios passed! (including expected validation failures)');
    }
}

// Handle command line arguments
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: bun run scripts/run-all-scenarios.ts [options]

Options:
  --help, -h    Show this help message
  --verbose, -v  Show detailed output for each scenario

This script runs all .scenario.yaml files in the examples directory
to ensure no regressions are introduced by changes.
  `);
    process.exit(0);
}

const verbose = args.includes('--verbose') || args.includes('-v');

// Run the scenarios
runAllScenarios().catch(error => {
    console.error('❌ Script failed:', error);
    process.exit(1);
}); 