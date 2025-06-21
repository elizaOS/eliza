import { Command } from 'commander';
import { logger } from '@elizaos/core';
import { runScenarioTests } from '../test/actions/scenario-tests.js';
// @ts-ignore: scenarios package doesn't have type definitions
import { ConsolidatedScenarioTestRunner } from '@elizaos/scenarios';
import { getProjectType } from '../test/utils/project-utils.js';
import { loadPluginsFromProject } from '../test/utils/plugin-utils.js';
import { ScenarioRuntimeValidator } from '@elizaos/core';
import { createTestAgent } from '../test/utils/agent-utils.js';
import type { PluginScenario } from '@elizaos/core';
import { generateScenarioCommand } from './generate.js';
import * as fs from 'fs';

export const scenarioCommand = new Command('scenario')
  .description('Run and manage scenario tests for ElizaOS agents')
  .addCommand(generateScenarioCommand);

// Add run subcommand
scenarioCommand
  .command('run')
  .description('Run scenario tests')
  .option('-s, --scenario <path>', 'Path to specific scenario file')
  .option('-d, --directory <path>', 'Directory containing scenario files')
  .option('-f, --filter <pattern>', 'Filter scenarios by name or tag')
  .option('--verbose', 'Show detailed output', false)
  .option('-b, --benchmark', 'Enable benchmarking', false)
  .option('-o, --output <file>', 'Output results to file')
  .option('--format <type>', 'Output format (json|text|html)', 'text')
  .option('--parallel', 'Run scenarios in parallel', false)
  .option('--max-concurrency <num>', 'Maximum concurrent scenarios', '1')
  .action(async (options) => {
    console.log('Scenario run command started with options:', options);

    // CRITICAL: Set database type to PGLite FIRST before any other operations
    // This must happen before any schema modules are imported or database operations occur
    try {
      const sqlModule = await import('@elizaos/plugin-sql');
      if ('setDatabaseType' in sqlModule && typeof sqlModule.setDatabaseType === 'function') {
        sqlModule.setDatabaseType('pglite');
        logger.info('✅ Set database type to PGLite for scenario testing at command level');
      } else {
        logger.error('❌ setDatabaseType not found in plugin-sql module');
      }
    } catch (error) {
      logger.error('❌ Failed to set database type:', error);
    }

    try {
      // Use the new plugin scenario system instead of the old standalone scenarios
      
      // Convert CLI options to test command options
      const testOptions = {
        type: 'scenario' as const,
        port: options.port,
        name: options.filter, // Map filter to name for test command compatibility
        skipBuild: true,
        skipTypeCheck: true,
        verbose: options.verbose,
        benchmark: options.benchmark,
        parallel: options.parallel,
        maxConcurrency: parseInt(options.maxConcurrency) || 1
      };

      logger.info('Running scenarios using plugin scenario system...');
      const result = await runScenarioTests(undefined, testOptions);

      // Display results using existing display function but adapt the data
      const adaptedResults = [];
      for (const pluginResult of result.results) {
        for (const scenario of pluginResult.scenarios) {
          adaptedResults.push({
            scenarioId: scenario.scenarioId,
            name: scenario.name,
            passed: scenario.passed,
            error: scenario.errors.length > 0 ? scenario.errors[0] : undefined,
            duration: scenario.duration,
            metrics: {
              duration: scenario.duration,
              messageCount: scenario.metrics.messageCount,
              stepCount: scenario.metrics.stepCount,
              tokenUsage: scenario.metrics.tokenUsage,
              memoryUsage: {
                peak: scenario.metrics.memoryUsage.peak,
                average: scenario.metrics.memoryUsage.average,
                memoryOperations: scenario.metrics.memoryUsage.operations
              },
              actionCounts: {}, // Would need to be extracted from transcript
              responseLatency: scenario.metrics.responseLatency,
            },
            verificationResults: scenario.verificationResults,
            transcript: scenario.transcript,
          });
        }
      }

      if (adaptedResults.length === 0) {
        logger.warn('No scenarios found in plugins matching the criteria');
        return;
      }

      // Display results
      displayResults(adaptedResults, options);

      // Save results if requested
      if (options.output) {
        await saveResultsToFile(adaptedResults, options.output, options.format);
      }

      // Exit with appropriate code
      const failed = adaptedResults.filter((r) => !r.passed).length;
      process.exit(failed > 0 ? 1 : 0);
    } catch (error) {
      logger.error('Scenario run failed:', error);
      process.exit(1);
    }
  });

// Add list subcommand
scenarioCommand
  .command('list')
  .description('List available scenarios from plugins')
  .option('-f, --filter <pattern>', 'Filter scenarios by name pattern')
  .option('--plugin <name>', 'Show scenarios only from specific plugin')
  .option('--detailed', 'Show detailed scenario information')
  .action(async (options) => {
    try {
      logger.info('📋 Loading scenarios from plugins...');
      
      const projectInfo = getProjectType(process.cwd());
      const plugins = await loadPluginsFromProject(process.cwd(), projectInfo);
      
      let totalScenarios = 0;
      let filteredScenarios = 0;
      
      for (const plugin of plugins) {
        if (plugin.scenarios && plugin.scenarios.length > 0) {
          // Apply plugin filter if specified
          if (options.plugin && plugin.name !== options.plugin) {
            continue;
          }
          
          let scenarios = plugin.scenarios;
          totalScenarios += scenarios.length;
          
          // Apply name filter if specified
          if (options.filter) {
            const pattern = options.filter.toLowerCase();
            scenarios = scenarios.filter(s => 
              s.name.toLowerCase().includes(pattern) ||
              s.description?.toLowerCase().includes(pattern)
            );
          }
          
          filteredScenarios += scenarios.length;
          
          if (scenarios.length > 0) {
            console.log(`\n📦 Plugin: ${plugin.name}`);
            console.log(`   Scenarios: ${scenarios.length}${options.filter ? ` (filtered from ${plugin.scenarios.length})` : ''}`);
            
            for (const scenario of scenarios) {
              console.log(`   📋 ${scenario.name}`);
              if (options.detailed) {
                if (scenario.description) {
                  console.log(`      Description: ${scenario.description}`);
                }
                if (scenario.characters && scenario.characters.length > 0) {
                  console.log(`      Characters: ${scenario.characters.length}`);
                  for (const char of scenario.characters) {
                    console.log(`        - ${char.name} (${char.role})`);
                  }
                }
                if (scenario.script && scenario.script.steps && scenario.script.steps.length > 0) {
                  console.log(`      Steps: ${scenario.script.steps.length}`);
                }
                if (scenario.verification && scenario.verification.rules && scenario.verification.rules.length > 0) {
                  console.log(`      Verification rules: ${scenario.verification.rules.length}`);
                }
                console.log('');
              }
            }
          }
        }
      }
      
      console.log(`\n📊 Summary: ${filteredScenarios} scenario(s) listed${options.filter ? ` (filtered from ${totalScenarios} total)` : ''}`);
      
      if (totalScenarios === 0) {
        logger.warn('No scenarios found in any plugins. Make sure plugins are properly installed and have scenarios defined.');
      }
      
    } catch (error) {
      logger.error('Failed to list scenarios:', error);
      process.exit(1);
    }
  });

// Add test subcommand (alias for run)
scenarioCommand
  .command('test')
  .description('Test scenarios (alias for run)')
  .option('-s, --scenarios <pattern>', 'Scenario name pattern to match')
  .option('-c, --character <path>', 'Character file to use')
  .option('-v, --verbose', 'Show detailed output', false)
  .action(async (options) => {
    // Convert test command options to run command options
    const runOptions = {
      filter: options.scenarios,
      verbose: options.verbose,
    };

    // Execute run command with converted options
    const runCommand = scenarioCommand.commands.find((cmd) => cmd.name() === 'run');
    if (runCommand) {
      // Create argv array for the run command
      const argv = ['run'];
      if (runOptions.filter) {
        argv.push('--filter', runOptions.filter);
      }
      if (runOptions.verbose) {
        argv.push('--verbose');
      }
      
      await runCommand.parseAsync(argv, { from: 'user' });
    }
  });

// Add validate subcommand
scenarioCommand
  .command('validate')
  .description('Validate scenario environment requirements')
  .option('--plugin <name>', 'Validate scenarios only from specific plugin')
  .option('-f, --filter <pattern>', 'Filter scenarios by name pattern')
  .action(async (options) => {
    try {
      logger.info('🔧 Validating scenario environments...');
      
      const projectInfo = getProjectType(process.cwd());
      const plugins = await loadPluginsFromProject(process.cwd(), projectInfo);
      
      // Extract all scenarios from plugins
      const allScenarios: PluginScenario[] = [];
      const pluginScenarioMap = new Map<string, PluginScenario[]>();
      
      for (const plugin of plugins) {
        if (plugin.scenarios && plugin.scenarios.length > 0) {
          // Apply plugin filter if specified
          if (options.plugin && plugin.name !== options.plugin) {
            continue;
          }
          
          let scenarios = plugin.scenarios;
          
          // Apply name filter if specified
          if (options.filter) {
            const pattern = options.filter.toLowerCase();
            scenarios = scenarios.filter(s => 
              s.name.toLowerCase().includes(pattern) ||
              s.description?.toLowerCase().includes(pattern)
            );
          }
          
          if (scenarios.length > 0) {
            allScenarios.push(...scenarios);
            pluginScenarioMap.set(plugin.name, scenarios);
          }
        }
      }
      
      if (allScenarios.length === 0) {
        logger.warn('No scenarios found for validation');
        return;
      }
      
      logger.info(`Validating ${allScenarios.length} scenarios...`);
      
      // Create a minimal runtime for validation
      const runtime = await createTestAgent(plugins, 3000);
      
      // Validate scenarios
      const validationResults = await ScenarioRuntimeValidator.validateScenarios(
        allScenarios,
        runtime
      );
      
      // Display validation results
      console.log(`\n🔍 Validation Results`);
      console.log('═'.repeat(50));
      
      let totalValid = 0;
      let totalInvalid = 0;
      let totalSkipped = 0;
      
      for (const [pluginName, scenarios] of pluginScenarioMap) {
        console.log(`\n📦 Plugin: ${pluginName}`);
        
        for (const scenario of scenarios) {
          const isExecutable = validationResults.executable.some(s => s.id === scenario.id);
          const isSkipped = validationResults.skipped.some(s => s.scenario.id === scenario.id);
          
          if (isExecutable) {
            console.log(`   ✅ ${scenario.name} - Valid`);
            totalValid++;
          } else if (isSkipped) {
            const skipInfo = validationResults.skipped.find(s => s.scenario.id === scenario.id);
            console.log(`   ⚠️  ${scenario.name} - Skipped: ${skipInfo?.reason}`);
            totalSkipped++;
          } else {
            console.log(`   ❌ ${scenario.name} - Invalid`);
            totalInvalid++;
          }
        }
      }
      
      // Environment validation details
      if (validationResults.environmentValidations.size > 0) {
        console.log(`\n🔧 Environment Issues`);
        console.log('─'.repeat(30));
        
        for (const [pluginName, validations] of validationResults.environmentValidations) {
          console.log(`\nPlugin: ${pluginName}`);
          for (const validation of validations) {
            if (validation.missingVars && validation.missingVars.length > 0) {
              console.log(`   Missing env vars: ${validation.missingVars.join(', ')}`);
            }
            if (validation.warnings.length > 0) {
              for (const warning of validation.warnings) {
                console.log(`   Warning: ${warning}`);
              }
            }
          }
        }
      }
      
      // Summary
      console.log(`\n📊 Validation Summary`);
      console.log('═'.repeat(50));
      console.log(`Total scenarios: ${allScenarios.length}`);
      console.log(`✅ Valid: ${totalValid}`);
      console.log(`❌ Invalid: ${totalInvalid}`);
      console.log(`⚠️  Skipped: ${totalSkipped}`);
      
      if (validationResults.warnings.length > 0) {
        console.log(`\n⚠️  Warnings:`);
        for (const warning of validationResults.warnings) {
          console.log(`   ${warning}`);
        }
      }
      
      // Exit with appropriate code
      process.exit(totalInvalid > 0 ? 1 : 0);
      
    } catch (error) {
      logger.error('Failed to validate scenarios:', error);
      process.exit(1);
    }
  });

// Add comprehensive test command using the scenarios package
scenarioCommand
  .command('test-all')
  .description('Run all scenarios using the consolidated test runner')
  .option('-f, --filter <pattern>', 'Filter scenarios by name or description')
  .option('-c, --category <category>', 'Filter scenarios by category')
  .option('-t, --tags <tags>', 'Filter scenarios by tags (comma-separated)')
  .option('--validate-only', 'Only validate environments, do not run scenarios')
  .option('--continue-on-error', 'Continue running scenarios after failures')
  .option('--verbose', 'Show detailed output', false)
  .option('-o, --output <file>', 'Output results to file')
  .option('--format <type>', 'Output format (json|console|both)', 'console')
  .action(async (options) => {
    try {
      logger.info('🚀 Running consolidated scenario tests...');
      
      const runner = new ConsolidatedScenarioTestRunner();
      const testOptions = {
        filter: options.filter,
        category: options.category,
        tags: options.tags ? options.tags.split(',').map((t: string) => t.trim()) : undefined,
        validateOnly: options.validateOnly,
        continueOnError: options.continueOnError,
        verbose: options.verbose,
        outputFile: options.output,
        outputFormat: options.format as 'json' | 'console' | 'both'
      };

      const results = await runner.runAllScenarios(testOptions);
      
      // Exit with appropriate code
      if (results.failed > 0) {
        process.exit(1);
      }
      
    } catch (error) {
      logger.error('Failed to run consolidated scenarios:', error);
      process.exit(1);
    }
  });


function displayResults(results: any[], options: any): void {
  console.log('\n🧪 ElizaOS Scenario Test Results');
  console.log('═'.repeat(60));

  let passed = 0;
  let failed = 0;
  let totalDuration = 0;
  let totalMessages = 0;
  let totalTokens = 0;

  for (const result of results) {
    const status = result.passed ? '✅ PASS' : '❌ FAIL';
    const duration = result.duration ? `${(result.duration / 1000).toFixed(2)}s` : 'N/A';
    const metrics = result.metrics || {};

    // Accumulate totals for summary
    if (result.duration) totalDuration += result.duration;
    if (metrics.messageCount) totalMessages += metrics.messageCount;
    if (metrics.tokenUsage?.total) totalTokens += metrics.tokenUsage.total;

    console.log(`\n${status} ${result.name}`);
    console.log(
      `   Duration: ${duration} | Messages: ${metrics.messageCount || 0} | Tokens: ${metrics.tokenUsage?.total || 0}`
    );

    if (options.benchmark || options.verbose) {
      // Show performance metrics
      if (metrics.responseLatency) {
        const latency = metrics.responseLatency;
        console.log(
          `   📊 Response Latency: avg ${latency.average?.toFixed(0) || 0}ms | p95 ${latency.p95?.toFixed(0) || 0}ms`
        );
      }

      if (metrics.memoryUsage) {
        const memory = metrics.memoryUsage;
        console.log(
          `   💾 Memory: peak ${(memory.peak / 1024 / 1024).toFixed(1)}MB | ops ${memory.memoryOperations || 0}`
        );
      }

      if (metrics.actionCounts && Object.keys(metrics.actionCounts).length > 0) {
        const actions = Object.entries(metrics.actionCounts)
          .map(([action, count]) => `${action}:${count}`)
          .join(', ');
        console.log(`   🎯 Actions: ${actions}`);
      }
    }

    if (result.error) {
      console.log(`   💥 Error: ${result.error}`);
    }

    // Show verification details
    if (result.verificationResults && result.verificationResults.length > 0) {
      const verificationPassed = result.verificationResults.filter((v: any) => v.passed).length;
      const verificationTotal = result.verificationResults.length;
      console.log(`   🔍 Verification: ${verificationPassed}/${verificationTotal} rules passed`);

      if (options.verbose) {
        for (const verification of result.verificationResults) {
          const verifyStatus = verification.passed ? '  ✓' : '  ✗';
          const score = verification.score ? ` (${(verification.score * 100).toFixed(0)}%)` : '';
          console.log(`   ${verifyStatus} ${verification.ruleName}${score}`);
          if (!verification.passed && verification.reason) {
            console.log(`      └─ ${verification.reason}`);
          }
        }
      }
    }

    if (result.passed) {
      passed++;
    } else {
      failed++;
    }
  }

  // Enhanced summary with benchmarks
  console.log('\n' + '═'.repeat(60));
  console.log('📈 SUMMARY REPORT');
  console.log('─'.repeat(30));
  console.log(
    `🎯 Results: ${passed}/${results.length} passed (${((passed / results.length) * 100).toFixed(1)}% success rate)`
  );

  if (totalDuration > 0) {
    console.log(
      `⏱️  Total Duration: ${(totalDuration / 1000).toFixed(2)}s (avg: ${(totalDuration / results.length / 1000).toFixed(2)}s per scenario)`
    );
  }

  if (totalMessages > 0) {
    console.log(
      `💬 Total Messages: ${totalMessages} (avg: ${(totalMessages / results.length).toFixed(1)} per scenario)`
    );
  }

  if (totalTokens > 0) {
    console.log(
      `🔤 Total Tokens: ${totalTokens.toLocaleString()} (avg: ${Math.round(totalTokens / results.length).toLocaleString()} per scenario)`
    );
  }

  // Recommendations
  if (failed > 0) {
    console.log('\n💡 RECOMMENDATIONS:');
    console.log('─'.repeat(30));
    const failedResults = results.filter((r) => !r.passed);
    const commonIssues = failedResults.map((r) => r.error).filter(Boolean);

    if (commonIssues.length > 0) {
      console.log('• Review failed scenarios with --verbose flag for detailed error analysis');
    }

    const hasVerificationFailures = failedResults.some((r) =>
      r.verificationResults?.some((v: any) => !v.passed)
    );

    if (hasVerificationFailures) {
      console.log('• Check verification rule configurations for failed scenarios');
    }

    if (totalDuration > 60000) {
      console.log('• Consider optimizing scenario execution time (current avg > 60s)');
    }

    console.log('• Run with --benchmark flag for detailed performance metrics');
  } else {
    console.log('\n🎉 All scenarios passed! Your agent system is performing well.');
    if (!options.benchmark) {
      console.log('💡 Run with --benchmark for detailed performance analysis');
    }
  }

  console.log('═'.repeat(60));
}

async function saveResultsToFile(
  results: any[],
  outputPath: string,
  format: string
): Promise<void> {
  const content =
    format === 'json'
      ? JSON.stringify(results, null, 2)
      : results.map((r) => `${r.passed ? 'PASS' : 'FAIL'}: ${r.name}`).join('\n');

  await fs.promises.writeFile(outputPath, content);
  logger.info(`Results saved to: ${outputPath}`);
}

export default scenarioCommand;
