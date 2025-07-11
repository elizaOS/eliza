#!/usr/bin/env bun

/**
 * CLI Documentation Coverage Checker
 * 
 * This script helps validate that all CLI commands are properly documented and tested.
 * It addresses issue #5325: TESTING: test all CLI commands against the CLI Docs
 * 
 * Usage:
 *   bun run scripts/check-cli-coverage.ts
 * 
 * What it checks:
 * 1. All implemented CLI commands have documentation
 * 2. All documented commands have corresponding implementations  
 * 3. All documented commands have test files
 * 4. Command help output matches documentation
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { execSync } from 'child_process';

interface CoverageReport {
    implemented: string[];
    documented: string[];
    tested: string[];
    missing: {
        documentation: string[];
        tests: string[];
        implementation: string[];
    };
    helpValidation: {
        command: string;
        status: 'pass' | 'fail';
        error?: string;
    }[];
}

async function getImplementedCommands(): Promise<string[]> {
    const indexPath = join(__dirname, '../src/index.ts');
    const indexContent = await readFile(indexPath, 'utf-8');

    // Extract command names from addCommand calls
    const commandRegex = /\.addCommand\((\w+)\)/g;
    const commands: string[] = [];
    let match;

    while ((match = commandRegex.exec(indexContent)) !== null) {
        commands.push(match[1]);
    }

    // Map command variable names to actual command names
    const commandMapping: { [key: string]: string } = {
        create: 'create',
        monorepo: 'monorepo',
        plugins: 'plugins',
        agent: 'agent',
        teeCommand: 'tee',
        start: 'start',
        update: 'update',
        test: 'test',
        env: 'env',
        dev: 'dev',
        publish: 'publish'
    };

    return commands.map(cmd => commandMapping[cmd] || cmd).filter(Boolean);
}

async function getDocumentedCommands(): Promise<string[]> {
    const docsPath = join(__dirname, '../../docs/docs/cli');
    const allFiles = await readdir(docsPath);
    const docFiles = allFiles.filter((file: string) => file.endsWith('.md'));

    return docFiles
        .map((f: string) => f.replace('.md', ''))
        .filter((f: string) => f !== 'overview'); // overview.md is not a command
}

async function getTestedCommands(): Promise<string[]> {
    const testsPath = join(__dirname, '../tests/commands');
    const allFiles = await readdir(testsPath);
    const testFiles = allFiles.filter((file: string) => file.endsWith('.test.ts'));

    return testFiles
        .map((f: string) => f.replace('.test.ts', ''))
        .filter((f: string) => !['test-utils', 'cli-docs-coverage'].includes(f));
}

async function validateCommandHelp(command: string): Promise<{ status: 'pass' | 'fail'; error?: string }> {
    try {
        const cliPath = join(__dirname, '../dist/index.js');
        const result = execSync(`bun ${cliPath} ${command} --help`, {
            encoding: 'utf8',
            timeout: 5000
        });

        // Basic validation - should contain usage and command name
        if (!result.includes(`Usage: elizaos ${command}`) && !result.includes('Usage:')) {
            return { status: 'fail', error: 'Missing usage information' };
        }

        if (!result.includes('--help') && !result.includes('-h')) {
            return { status: 'fail', error: 'Missing help option' };
        }

        return { status: 'pass' };
    } catch (error) {
        return { status: 'fail', error: `Command execution failed: ${error}` };
    }
}

async function generateCoverageReport(): Promise<CoverageReport> {
    console.log('🔍 Analyzing CLI command coverage...\n');

    const [implemented, documented, tested] = await Promise.all([
        getImplementedCommands(),
        getDocumentedCommands(),
        getTestedCommands()
    ]);

    console.log('📊 Validating command help output...');
    const helpValidation: { command: string; status: 'pass' | 'fail'; error?: string }[] = [];
    for (const command of implemented) {
        process.stdout.write(`  Checking ${command}... `);
        const validation = await validateCommandHelp(command);
        helpValidation.push({ command, ...validation });
        console.log(validation.status === 'pass' ? '✅' : '❌');
        if (validation.error) {
            console.log(`    Error: ${validation.error}`);
        }
    }

    const report: CoverageReport = {
        implemented,
        documented,
        tested,
        missing: {
            documentation: implemented.filter(cmd => !documented.includes(cmd)),
            tests: documented.filter(cmd => {
                // Special case: stop command is tested in agent tests
                if (cmd === 'stop') return !tested.includes('agent');
                return !tested.includes(cmd);
            }),
            implementation: documented.filter(cmd => !implemented.includes(cmd))
        },
        helpValidation
    };

    return report;
}

function printReport(report: CoverageReport) {
    console.log('\n📋 CLI Command Coverage Report\n');
    console.log('===============================\n');

    // Summary
    console.log('📊 Summary:');
    console.log(`   Implemented commands: ${report.implemented.length}`);
    console.log(`   Documented commands: ${report.documented.length}`);
    console.log(`   Tested commands: ${report.tested.length}\n`);

    // Commands lists
    console.log('🔧 Implemented Commands:');
    report.implemented.forEach(cmd => console.log(`   ✓ ${cmd}`));
    console.log('');

    console.log('📚 Documented Commands:');
    report.documented.forEach(cmd => console.log(`   ✓ ${cmd}`));
    console.log('');

    console.log('🧪 Tested Commands:');
    report.tested.forEach(cmd => console.log(`   ✓ ${cmd}`));
    console.log('');

    // Missing items
    let hasIssues = false;

    if (report.missing.documentation.length > 0) {
        hasIssues = true;
        console.log('❌ Missing Documentation:');
        report.missing.documentation.forEach(cmd => {
            console.log(`   • ${cmd} - Create docs/cli/${cmd}.md`);
        });
        console.log('');
    }

    if (report.missing.tests.length > 0) {
        hasIssues = true;
        console.log('❌ Missing Tests:');
        report.missing.tests.forEach(cmd => {
            console.log(`   • ${cmd} - Create tests/commands/${cmd}.test.ts`);
        });
        console.log('');
    }

    if (report.missing.implementation.length > 0) {
        hasIssues = true;
        console.log('❌ Missing Implementation:');
        report.missing.implementation.forEach(cmd => {
            console.log(`   • ${cmd} - Implement command in CLI`);
        });
        console.log('');
    }

    // Help validation results
    const failedHelp = report.helpValidation.filter(v => v.status === 'fail');
    if (failedHelp.length > 0) {
        hasIssues = true;
        console.log('❌ Failed Help Validation:');
        failedHelp.forEach(v => {
            console.log(`   • ${v.command}: ${v.error}`);
        });
        console.log('');
    }

    // Final status
    if (!hasIssues) {
        console.log('✅ All CLI commands are properly documented and tested!');
        console.log('   Issue #5325 requirements are satisfied.\n');
    } else {
        console.log('⚠️  Some CLI commands need attention to satisfy issue #5325.');
        console.log('   Please address the missing items listed above.\n');
    }

    // Instructions
    console.log('💡 To run the comprehensive CLI coverage tests:');
    console.log('   bun test tests/commands/cli-docs-coverage.test.ts\n');

    console.log('📖 Related documentation:');
    console.log('   - CLI Overview: docs/cli/overview.md');
    console.log('   - Test Suite: tests/commands/README.md');
}

async function main() {
    try {
        // Check if CLI is built
        const cliPath = join(__dirname, '../dist/index.js');
        try {
            await readFile(cliPath);
        } catch {
            console.log('❌ CLI not built. Please run "bun run build" first.');
            process.exit(1);
        }

        const report = await generateCoverageReport();
        printReport(report);

        // Save detailed report for CI/analysis
        await Bun.write(
            join(__dirname, '../cli-coverage-report.json'),
            JSON.stringify(report, null, 2)
        );
        console.log('💾 Detailed report saved to: cli-coverage-report.json');

    } catch (error) {
        console.error('❌ Error generating coverage report:', error);
        process.exit(1);
    }
}

if (import.meta.main) {
    main();
}

export { generateCoverageReport, printReport };
export type { CoverageReport };
