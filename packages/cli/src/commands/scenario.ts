import { Command } from 'commander';
import { logger } from '@elizaos/core';
import { handleError } from '@/src/utils';
import { runScenarioTests } from './test/actions/scenario-tests';
import { getProjectType } from './test/utils/project-utils';

// Create scenario command for running scenarios independently
export const scenario = new Command()
  .name('scenario')
  .description('Run plugin scenarios for testing agent capabilities')
  .argument('[path]', 'Optional path to the project or plugin containing scenarios')
  .option('-p, --port <port>', 'Port for test server (default: 3000)', parseInt)
  .option('--name <name>', 'Filter scenarios by name pattern')
  .option('--plugin <plugin>', 'Run scenarios only from specific plugin')
  .option('--skip-validation', 'Skip environment validation checks')
  .option('--verbose', 'Enable verbose logging during scenario execution')
  .option('--timeout <timeout>', 'Timeout per scenario in milliseconds (default: 30000)', parseInt)
  .action(async (testPath: string | undefined, options) => {
    try {
      logger.info('🎭 Starting scenario execution...');

      // Parse options
      const scenarioOptions = {
        type: 'scenario' as const,
        port: options.port,
        name: options.name,
        skipBuild: true, // Scenarios don't need build step
        skipTypeCheck: true, // Scenarios focus on runtime behavior
        plugin: options.plugin,
        skipValidation: options.skipValidation,
        verbose: options.verbose,
        timeout: options.timeout || 30000,
      };

      if (options.verbose) {
        logger.info('Scenario options:', scenarioOptions);
      }

      // Get project information
      const projectInfo = getProjectType(testPath);
      
      if (options.verbose) {
        logger.info('Project info:', {
          type: projectInfo.type,
          hasPackageJson: projectInfo.hasPackageJson,
          hasElizaOSDependencies: projectInfo.hasElizaOSDependencies,
        });
      }

      // Run scenarios
      const result = await runScenarioTests(testPath, scenarioOptions);

      // Report results
      if (result.success) {
        const totalExecuted = result.results.reduce((sum, r) => sum + r.summary.totalScenarios, 0);
        const totalPassed = result.results.reduce((sum, r) => sum + r.summary.passedScenarios, 0);
        const totalSkipped = result.skippedScenarios.length;

        logger.success(`✅ Scenario execution completed successfully!`);
        logger.info(`📊 Results: ${totalPassed}/${totalExecuted} passed, ${totalSkipped} skipped`);

        // Show detailed results if verbose
        if (options.verbose) {
          logger.info('\n📋 Detailed Results:');
          for (const pluginResult of result.results) {
            logger.info(`\n  Plugin: ${pluginResult.pluginName}`);
            logger.info(`    Scenarios: ${pluginResult.summary.totalScenarios}`);
            logger.info(`    Passed: ${pluginResult.summary.passedScenarios}`);
            
            for (const scenario of pluginResult.scenarios) {
              const status = scenario.passed ? '✅' : '❌';
              const score = scenario.score ? ` (${(scenario.score * 100).toFixed(1)}%)` : '';
              logger.info(`      ${status} ${scenario.name}${score}`);
              
              if (!scenario.passed && scenario.errors.length > 0) {
                for (const error of scenario.errors) {
                  logger.warn(`        Error: ${error}`);
                }
              }
            }
          }

          // Show skipped scenarios
          if (result.skippedScenarios.length > 0) {
            logger.info('\n⏭️  Skipped Scenarios:');
            for (const { scenario, reason } of result.skippedScenarios) {
              logger.warn(`    ⚠️  ${scenario.name}: ${reason}`);
            }
          }

          // Show environment validation issues
          if (result.environmentValidations.size > 0) {
            logger.info('\n🔧 Environment Validation Results:');
            for (const [pluginName, validations] of result.environmentValidations) {
              logger.info(`  Plugin: ${pluginName}`);
              for (const validation of validations) {
                if (validation.missingVars.length > 0) {
                  logger.warn(`    Missing env vars: ${validation.missingVars.join(', ')}`);
                }
                if (validation.warnings.length > 0) {
                  for (const warning of validation.warnings) {
                    logger.warn(`    Warning: ${warning}`);
                  }
                }
              }
            }
          }
        }

        process.exit(0);
      } else {
        logger.error('❌ Scenario execution failed');
        
        // Show error details
        for (const pluginResult of result.results) {
          const failedScenarios = pluginResult.scenarios.filter(s => !s.passed);
          if (failedScenarios.length > 0) {
            logger.error(`\nFailed scenarios in ${pluginResult.pluginName}:`);
            for (const scenario of failedScenarios) {
              logger.error(`  ❌ ${scenario.name}`);
              for (const error of scenario.errors) {
                logger.error(`    Error: ${error}`);
              }
            }
          }
        }

        process.exit(1);
      }

    } catch (error) {
      handleError(error);
    }
  });

// Add scenario list subcommand
scenario
  .command('list')
  .description('List all available scenarios in the project')
  .argument('[path]', 'Optional path to the project or plugin')
  .option('--plugin <plugin>', 'List scenarios only from specific plugin')
  .option('--detailed', 'Show detailed scenario information')
  .action(async (_testPath: string | undefined, _options) => {
    try {
      logger.info('📋 Listing available scenarios...');

      // This would require loading plugins and extracting scenario metadata
      // For now, we'll show a placeholder message
      logger.info('Scenario listing functionality will be implemented in the next phase.');
      logger.info('Use "elizaos test --type scenario" to run all scenarios for now.');

    } catch (error) {
      handleError(error);
    }
  });

// Add scenario validate subcommand
scenario
  .command('validate')
  .description('Validate scenario environment requirements')
  .argument('[path]', 'Optional path to the project or plugin')
  .option('--plugin <plugin>', 'Validate scenarios only from specific plugin')
  .action(async (_testPath: string | undefined, _options) => {
    try {
      logger.info('🔧 Validating scenario environments...');

      // This would run environment validation without executing scenarios
      // For now, we'll show a placeholder message
      logger.info('Scenario validation functionality will be implemented in the next phase.');
      logger.info('Use "elizaos test --type scenario" to run validation as part of execution.');

    } catch (error) {
      handleError(error);
    }
  });

export default scenario;