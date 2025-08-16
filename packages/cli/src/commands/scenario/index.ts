import { Command } from 'commander';
import * as yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { logger as elizaLogger } from '@elizaos/core';
import { ScenarioSchema, Scenario } from '../scenario/src/schema';
import { LocalEnvironmentProvider } from '../scenario/src/LocalEnvironmentProvider';
import { E2BEnvironmentProvider } from '../scenario/src/E2BEnvironmentProvider';
import { EnvironmentProvider } from '../scenario/src/providers';
import { createScenarioServerAndAgent } from '../scenario/src/runtime-factory';

import { MockEngine } from './src/MockEngine';
import { EvaluationEngine } from './src/EvaluationEngine';
import { Reporter } from './src/Reporter';
import { PluginParser } from './src/plugin-parser';

/**
 * Safe evaluation runner with fallback mechanism for ticket #5783
 * Uses enhanced evaluations by default, falls back to original boolean evaluations on any error
 */
async function runEvaluationsWithFallback(
    evaluationEngine: EvaluationEngine,
    evaluations: any[],
    result: any
) {
    const logger = elizaLogger || console;

    try {
        // Attempt enhanced evaluations (default behavior)
        logger.debug('[Evaluation] Using enhanced evaluations with structured output');
        const enhancedResults = await evaluationEngine.runEnhancedEvaluations(evaluations, result);

        // Validate that we got proper structured results
        if (Array.isArray(enhancedResults) && enhancedResults.length > 0) {
            const firstResult = enhancedResults[0];
            if (firstResult &&
                typeof firstResult.evaluator_type === 'string' &&
                typeof firstResult.success === 'boolean' &&
                typeof firstResult.summary === 'string' &&
                typeof firstResult.details === 'object') {

                logger.debug(`[Evaluation] Enhanced evaluations successful - ${enhancedResults.length} structured results`);

                // Convert enhanced results back to legacy format for compatibility
                return enhancedResults.map(enhanced => ({
                    success: enhanced.success,
                    message: enhanced.summary,
                    // Store enhanced data for future use
                    _enhanced: enhanced
                }));
            }
        }

        // Enhanced results invalid - fall through to legacy
        logger.warn('[Evaluation] Enhanced results invalid, falling back to legacy evaluations');

    } catch (error) {
        // Enhanced evaluations failed - fall back to legacy
        logger.warn(`[Evaluation] Enhanced evaluations failed (${error.message}), falling back to legacy evaluations`);
    }

    // Fallback to original evaluation system
    logger.debug('[Evaluation] Using legacy evaluation system (fallback)');
    return await evaluationEngine.runEvaluations(evaluations, result);
}

export const scenario = new Command()
    .name('scenario')
    .description('Manage and execute ElizaOS scenarios')
    .addCommand(
        new Command('run')
            .argument('<filePath>', 'Path to the .scenario.yaml file')
            .option('-l, --live', 'Run scenario in live mode, ignoring mocks', false)
            .description('Execute a scenario from a YAML file')
            .action(async (filePath: string, options: { live: boolean }) => {
                const logger = elizaLogger || console;
                logger.info(`Starting scenario run with args: ${JSON.stringify({ filePath, ...options })}`);
                let provider: EnvironmentProvider | null = null;
                let runtime: any = null;
                let server: any = null;
                let agentId: any = null;
                let createdServer = false;
                let mockEngine: MockEngine | null = null;
                let finalStatus = false; // Default to fail
                let reporter: Reporter | null = null;

                try {
                    const fullPath = path.resolve(filePath);
                    logger.info(`Attempting to read scenario file from: ${fullPath}`);
                    if (!fs.existsSync(fullPath)) {
                        logger.error(`Error: File not found at '${fullPath}'`);
                        process.exit(1);
                    }
                    const fileContents = fs.readFileSync(fullPath, 'utf8');
                    const rawScenario = yaml.load(fileContents);
                    // Validate using Zod
                    const validationResult = ScenarioSchema.safeParse(rawScenario);
                    if (!validationResult.success) {
                        logger.error('Scenario file validation failed:');
                        console.error(JSON.stringify(validationResult.error.format(), null, 2));
                        process.exit(1);
                    }
                    const scenario: Scenario = validationResult.data;

                    // Parse and validate plugins if specified
                    if (scenario.plugins && scenario.plugins.length > 0) {
                        logger.info('Parsing and validating plugins...');
                        const pluginResult = await PluginParser.parseAndValidate(scenario.plugins);

                        if (!pluginResult.valid) {
                            logger.error('Plugin validation failed:');
                            pluginResult.errors.forEach((error) => logger.error(`  - ${error}`));
                            process.exit(1);
                        }

                        if (pluginResult.warnings.length > 0) {
                            logger.warn('Plugin warnings:');
                            pluginResult.warnings.forEach((warning) => logger.warn(`  - ${warning}`));
                        }

                        logger.info(PluginParser.generateSummary(pluginResult));

                        // Store parsed plugins for later use
                        (scenario as any).parsedPlugins = pluginResult.plugins;
                    } else {
                        logger.info('No plugins specified in scenario');
                    }
                    // TODO: use parsedPlugins to initialize the runtime
                    // Initialize Reporter
                    reporter = new Reporter();
                    reporter.reportStart(scenario);
                    const defaultPlugins = [
                        '@elizaos/plugin-sql',
                        '@elizaos/plugin-bootstrap',
                        '@elizaos/plugin-e2b',
                        '@elizaos/plugin-openai',
                    ];
                    // Ensure PGLite uses isolated directory per scenario run when not overridden
                    if (!process.env.PGLITE_DATA_DIR) {
                        const uniqueDir = `${process.cwd()}/test-data/scenario-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                        process.env.PGLITE_DATA_DIR = uniqueDir;
                    }
                    // Extract plugin names from scenario configuration, filtering by enabled status
                    const scenarioPlugins = Array.isArray((scenario as any).plugins)
                        ? (scenario as any).plugins
                            .filter((p: any) => p.enabled !== false) // Only include enabled plugins (default to true if not specified)
                            .map((p: any) => (typeof p === 'string' ? p : p.name)) // Extract name if it's an object
                        : [];
                    const finalPlugins = Array.from(new Set([...scenarioPlugins, ...defaultPlugins]));
                    logger.info(`Using plugins: ${JSON.stringify(finalPlugins)}`);
                    // Determine environment provider based on scenario type
                    if (scenario.environment.type === 'e2b') {
                        // Create server and start agent once, reuse for steps. Include E2B plugin if available.
                        const created = await createScenarioServerAndAgent(null, 3000, finalPlugins);
                        server = created.server;
                        runtime = created.runtime;
                        agentId = created.agentId;
                        createdServer = created.createdServer;
                        // Prefer E2B provider when the service is present; otherwise gracefully fall back to local
                        const hasE2B = !!runtime.getService?.('e2b');
                        provider = hasE2B
                            ? new E2BEnvironmentProvider(runtime, server, agentId)
                            : new LocalEnvironmentProvider(server, agentId);
                    } else if (scenario.environment.type === 'local') {
                        // Local also may need NL interaction; pass server/agent if already created
                        if (!server || !runtime || !agentId) {
                            const created = await createScenarioServerAndAgent(null, 3000, finalPlugins);
                            server = created.server;
                            runtime = created.runtime;
                            agentId = created.agentId;
                            createdServer = created.createdServer;
                        }
                        provider = new LocalEnvironmentProvider(server, agentId);
                        logger.info('Using local environment');
                    } else {
                        logger.error(`Unsupported environment type: '${scenario.environment.type}'`);
                        process.exit(1);
                    }

                    // Initialize MockEngine if we have a runtime and mocks are defined
                    if (runtime && scenario.setup?.mocks && !options.live) {
                        logger.info('Initializing MockEngine...');
                        mockEngine = new MockEngine(runtime);
                        logger.info('Applying mocks...');
                        mockEngine.applyMocks(scenario.setup.mocks);
                    }

                    logger.info(`Setting up '${scenario.environment.type}' environment...`);
                    await provider.setup(scenario);
                    logger.info('Executing run block...');
                    const results = await provider.run(scenario);

                    // Report execution results using Reporter
                    results.forEach((result) => {
                        reporter?.reportExecutionResult(result);
                    });

                    // Run evaluations for each step
                    const allEvaluationResults: any[] = [];

                    if (runtime) {
                        // Full evaluation engine with runtime for complex evaluators
                        const evaluationEngine = new EvaluationEngine(runtime);
                        logger.info('Running evaluations with runtime...');

                        for (let i = 0; i < results.length; i++) {
                            const step = scenario.run[i];
                            const result = results[i];

                            if (step.evaluations && step.evaluations.length > 0) {
                                const evaluationResults = await runEvaluationsWithFallback(
                                    evaluationEngine,
                                    step.evaluations,
                                    result
                                );
                                fs.writeFileSync(`./evaluation-results-${i}.json`, JSON.stringify(evaluationResults, null, 2));
                                allEvaluationResults.push(...evaluationResults);
                            }
                        }
                    } else {
                        // Simple evaluators that don't require runtime
                        logger.info('Running basic evaluations without runtime...');

                        for (let i = 0; i < results.length; i++) {
                            const step = scenario.run[i];
                            const result = results[i];

                            if (step.evaluations && step.evaluations.length > 0) {
                                for (const evaluation of step.evaluations) {
                                    let evaluationResult: any;

                                    // Handle basic evaluators that don't need runtime
                                    if (evaluation.type === 'string_contains') {
                                        const success = result.stdout.includes(evaluation.value);
                                        evaluationResult = {
                                            success,
                                            message: `Checked if stdout contains "${evaluation.value}". Result: ${success}`,
                                        };
                                    } else if (evaluation.type === 'regex_match') {
                                        const success = new RegExp(evaluation.pattern).test(result.stdout);
                                        evaluationResult = {
                                            success,
                                            message: `Checked if stdout matches regex "${evaluation.pattern}". Result: ${success}`,
                                        };
                                    } else {
                                        // Unknown evaluator type
                                        evaluationResult = {
                                            success: false,
                                            message: `Unknown evaluator type: '${evaluation.type}' (requires runtime)`,
                                        };
                                    }

                                    allEvaluationResults.push(evaluationResult);
                                }
                            }
                        }
                    }

                    // Report evaluation results using Reporter
                    reporter?.reportEvaluationResults(allEvaluationResults);

                    // Apply judgment logic
                    if (scenario.judgment?.strategy === 'all_pass') {
                        finalStatus = allEvaluationResults.every((res) => res.success);
                    } else if (scenario.judgment?.strategy === 'any_pass') {
                        finalStatus = allEvaluationResults.some((res) => res.success);
                    } else {
                        // Default to fail for unknown strategies
                        finalStatus = false;
                    }
                } catch (error) {
                    logger.error('An error occurred during scenario execution:');
                    logger.error(error instanceof Error ? error.message : String(error));
                    process.exit(1);
                } finally {
                    // Revert mocks first to ensure clean state
                    if (mockEngine) {
                        logger.info('Reverting mocks...');
                        mockEngine.revertMocks();
                    }

                    if (provider) {
                        logger.info('Tearing down environment...');
                        await provider.teardown();
                    }
                    if (runtime) {
                        try {
                            // Explicitly stop the E2B service to ensure clean shutdown
                            const e2bService = runtime.getService('e2b');
                            if (e2bService && typeof e2bService.stop === 'function') {
                                logger.info('Stopping E2B service...');
                                await e2bService.stop();
                            }
                            await runtime.close();
                            logger.info('Runtime shutdown complete');
                        } catch { }
                    }
                    if (server && createdServer) {
                        try {
                            await server.stop();
                        } catch { }
                    }

                    // Report final result and exit with appropriate code
                    reporter?.reportFinalResult(finalStatus);
                    process.exit(finalStatus ? 0 : 1);
                }
            })
    )
    .addCommand(
        new Command('matrix')
            .argument('<configPath>', 'Path to the matrix configuration .yaml file')
            .option('--dry-run', 'Show matrix analysis without executing tests', false)
            .option('--parallel <number>', 'Maximum number of parallel test runs', '1')
            .option('--filter <pattern>', 'Filter parameter combinations by pattern')
            .option('--verbose', 'Show detailed progress information', false)
            .description('Execute a scenario matrix from a configuration file')
            .action(
                async (
                    configPath: string,
                    options: {
                        dryRun: boolean;
                        parallel: string;
                        filter?: string;
                        verbose: boolean;
                    }
                ) => {
                    // Import matrix-specific modules only when needed
                    const { validateMatrixConfig, calculateTotalCombinations, calculateTotalRuns } =
                        await import('./src/matrix-schema');
                    const {
                        generateMatrixCombinations,
                        createExecutionContext,
                        filterCombinations,
                        calculateExecutionStats,
                        formatDuration,
                    } = await import('./src/matrix-runner');
                    const { validateMatrixParameterPaths, combinationToOverrides, applyParameterOverrides } =
                        await import('./src/parameter-override');

                    const logger = elizaLogger || console;
                    logger.info(`🧪 Starting matrix analysis with config: ${configPath}`);

                    if (options.verbose) {
                        logger.info(`Options: ${JSON.stringify(options, null, 2)}`);
                    }

                    try {
                        // Step 1: Load and validate configuration file
                        const fullPath = path.resolve(configPath);
                        logger.info(`📂 Loading matrix configuration from: ${fullPath}`);

                        if (!fs.existsSync(fullPath)) {
                            logger.error(`❌ Error: Matrix configuration file not found at '${fullPath}'`);
                            logger.info('💡 Make sure the file exists and the path is correct.');
                            process.exit(1);
                        }

                        const fileContents = fs.readFileSync(fullPath, 'utf8');
                        let rawMatrixConfig: any;

                        try {
                            rawMatrixConfig = yaml.load(fileContents);
                        } catch (yamlError) {
                            logger.error(`❌ Error: Failed to parse YAML configuration file:`);
                            logger.error(yamlError instanceof Error ? yamlError.message : String(yamlError));
                            logger.info('💡 Check that your YAML syntax is valid.');
                            process.exit(1);
                        }

                        // Step 2: Validate matrix configuration
                        logger.info('🔍 Validating matrix configuration...');
                        const validationResult = validateMatrixConfig(rawMatrixConfig);

                        if (!validationResult.success) {
                            logger.error('❌ Matrix configuration validation failed:');
                            const errors = validationResult.error.format();

                            // Display user-friendly error messages
                            const formatErrors = (obj: any, path: string = ''): void => {
                                if (obj._errors && obj._errors.length > 0) {
                                    obj._errors.forEach((error: string) => {
                                        logger.error(`   ${path}: ${error}`);
                                    });
                                }

                                Object.keys(obj).forEach((key) => {
                                    if (key !== '_errors' && typeof obj[key] === 'object') {
                                        const newPath = path ? `${path}.${key}` : key;
                                        formatErrors(obj[key], newPath);
                                    }
                                });
                            };

                            formatErrors(errors);
                            logger.info('💡 Please fix the configuration errors and try again.');
                            logger.info('📖 See the matrix testing documentation for examples and guidance.');
                            process.exit(1);
                        }

                        const matrixConfig = validationResult.data;
                        logger.info('✅ Matrix configuration is valid!');

                        // Step 3: Analyze matrix dimensions
                        const totalCombinations = calculateTotalCombinations(matrixConfig);
                        const totalRuns = calculateTotalRuns(matrixConfig);

                        // Step 4: Display matrix analysis
                        logger.info('\n📊 Matrix Analysis:');
                        logger.info(`   Name: ${matrixConfig.name}`);
                        if (matrixConfig.description) {
                            logger.info(`   Description: ${matrixConfig.description}`);
                        }
                        logger.info(`   Base Scenario: ${matrixConfig.base_scenario}`);
                        logger.info(`   Runs per combination: ${matrixConfig.runs_per_combination}`);
                        logger.info(`   Matrix axes: ${matrixConfig.matrix.length}`);
                        logger.info(`   Total combinations: ${totalCombinations}`);
                        logger.info(`   Total test runs: ${totalRuns}`);

                        // Display matrix structure
                        logger.info('\n🎯 Matrix Structure:');
                        matrixConfig.matrix.forEach((axis, index) => {
                            logger.info(`   Axis ${index + 1}: ${axis.parameter}`);
                            logger.info(`     Values: [${axis.values.map((v) => JSON.stringify(v)).join(', ')}]`);
                            logger.info(`     Count: ${axis.values.length}`);
                        });

                        // Step 5: Verify base scenario exists and load it
                        const baseScenarioPath = path.resolve(matrixConfig.base_scenario);
                        if (!fs.existsSync(baseScenarioPath)) {
                            logger.error(`\n❌ Error: Base scenario file not found at '${baseScenarioPath}'`);
                            logger.info('💡 Make sure the base_scenario path in your matrix config is correct.');
                            process.exit(1);
                        }
                        logger.info(`✅ Base scenario file found: ${baseScenarioPath}`);

                        // Load and validate base scenario
                        let baseScenario: any;
                        try {
                            const baseScenarioContents = fs.readFileSync(baseScenarioPath, 'utf8');
                            baseScenario = yaml.load(baseScenarioContents);

                            // Validate base scenario structure
                            const baseValidationResult = ScenarioSchema.safeParse(baseScenario);
                            if (!baseValidationResult.success) {
                                logger.error(`\n❌ Error: Base scenario file is invalid:`);
                                logger.error(JSON.stringify(baseValidationResult.error.format(), null, 2));
                                process.exit(1);
                            }
                            logger.info(`✅ Base scenario is valid`);
                        } catch (yamlError) {
                            logger.error(`\n❌ Error: Failed to parse base scenario YAML file:`);
                            logger.error(yamlError instanceof Error ? yamlError.message : String(yamlError));
                            process.exit(1);
                        }

                        // Step 5.5: Validate matrix parameter paths against base scenario
                        logger.info(`🔍 Validating matrix parameter paths...`);
                        const pathValidation = validateMatrixParameterPaths(baseScenario, matrixConfig.matrix);
                        if (!pathValidation.valid) {
                            logger.error(`\n❌ Error: Invalid parameter paths in matrix configuration:`);
                            pathValidation.invalidPaths.forEach((invalidPath) => {
                                logger.error(`   - ${invalidPath}`);
                            });
                            logger.info('💡 Make sure all parameter paths exist in your base scenario.');
                            logger.info('📖 Check the matrix testing documentation for parameter path examples.');
                            process.exit(1);
                        }
                        logger.info(`✅ All matrix parameter paths are valid`);

                        // Step 6: Generate matrix combinations using proper API from ticket #5779
                        const combinations = generateMatrixCombinations(matrixConfig);

                        if (options.verbose || options.dryRun) {
                            logger.info('\n🔀 Matrix Combinations:');
                            combinations.forEach((combo, index) => {
                                logger.info(
                                    `   ${index + 1}. ${combo.id}: ${JSON.stringify(combo.parameters, null, 0)}`
                                );
                            });

                            // Show parameter combination details for the first combination
                            if (combinations.length > 0 && options.verbose) {
                                logger.info('\n🛠️  Parameter Override Preview:');
                                try {
                                    const firstCombination = combinations[0];
                                    const overrides = combinationToOverrides(firstCombination.parameters);
                                    const modifiedScenario = applyParameterOverrides(baseScenario, overrides);

                                    logger.info(`   📋 Example: ${firstCombination.id}`);
                                    logger.info(
                                        `   📊 Metadata: ${firstCombination.metadata.combinationIndex + 1} of ${firstCombination.metadata.totalCombinations}`
                                    );
                                    logger.info(`   📝 Original scenario name: "${baseScenario.name}"`);
                                    logger.info(`   📝 Modified scenario ready for execution`);
                                    logger.info(`   📝 Parameters applied:`);

                                    // Show specific parameter changes
                                    overrides.forEach((override) => {
                                        logger.info(`   🔧 ${override.path}: ${JSON.stringify(override.value)}`);
                                    });

                                    logger.info(
                                        `   📝 This combination will run ${matrixConfig.runs_per_combination} time(s)`
                                    );
                                } catch (error) {
                                    logger.warn(
                                        `   ⚠️  Could not generate override preview: ${error instanceof Error ? error.message : String(error)}`
                                    );
                                }
                            }
                        }

                        // Step 7: Apply filters if specified
                        let filteredCombinations = combinations;
                        if (options.filter) {
                            logger.info(`\n🔍 Applying filter: ${options.filter}`);
                            filteredCombinations = filterCombinations(combinations, options.filter);
                            logger.info(`   Filtered to ${filteredCombinations.length} combinations`);
                        }

                        // Step 8: Warn about large matrices
                        if (totalRuns > 50) {
                            logger.info(`\n⚠️  Warning: This matrix will execute ${totalRuns} total test runs.`);
                            logger.info('   This may take a significant amount of time and resources.');
                            logger.info(
                                '   Consider using --filter to reduce the scope or increasing --parallel for faster execution.'
                            );
                        }

                        // Step 9: Show execution plan
                        if (options.dryRun) {
                            logger.info('\n🔍 Dry Run Complete - Matrix Analysis Only');
                            logger.info('✨ Matrix configuration is valid and ready for execution.');
                            logger.info('📝 To execute the matrix, run the same command without --dry-run');
                            process.exit(0);
                        } else {
                            // Calculate execution statistics
                            const executionStats = calculateExecutionStats(
                                filteredCombinations,
                                matrixConfig.runs_per_combination
                            );

                            logger.info('\n🚀 Matrix Execution Plan:');
                            logger.info(`   Parallel execution: ${options.parallel} concurrent runs`);
                            logger.info(`   Total combinations to execute: ${executionStats.totalCombinations}`);
                            logger.info(`   Total runs: ${executionStats.totalRuns}`);
                            logger.info(
                                `   Estimated duration: ${formatDuration(executionStats.estimatedDuration.realistic)} (realistic)`
                            );
                            logger.info(
                                `   Duration range: ${formatDuration(executionStats.estimatedDuration.optimistic)} - ${formatDuration(executionStats.estimatedDuration.pessimistic)}`
                            );

                            // Create execution context for future use
                            const executionContext = createExecutionContext(matrixConfig, filteredCombinations, {
                                parallelism: parseInt(options.parallel, 10),
                                dryRun: false,
                                filter: options.filter,
                                verbose: options.verbose,
                            });

                            logger.info('\n✅ Matrix Ready for Execution:');
                            logger.info('   🎯 Matrix configuration: ✅ Valid');
                            logger.info('   🎯 Parameter combinations: ✅ Generated');
                            logger.info('   🎯 Execution context: ✅ Prepared');
                            logger.info('   🎯 Base scenario: ✅ Validated');

                            // Import orchestrator for actual execution
                            const { executeMatrixRuns } = await import('./src/matrix-orchestrator');

                            logger.info('\n🚀 Starting Matrix Execution...');

                            // Create output directory with timestamp
                            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                            const outputDir = path.resolve(`output/matrix-${timestamp}`);

                            // Execute the matrix with full orchestration
                            const results = await executeMatrixRuns(matrixConfig, filteredCombinations, {
                                outputDir,
                                maxParallel: parseInt(options.parallel, 10),
                                continueOnFailure: true,
                                runTimeout: 300000, // 5 minutes per run
                                verbose: options.verbose,
                                onProgress: (message, eventType, data) => {
                                    if (
                                        options.verbose ||
                                        eventType === 'MATRIX_STARTED' ||
                                        eventType === 'COMBINATION_COMPLETED' ||
                                        eventType === 'MATRIX_COMPLETED'
                                    ) {
                                        logger.info(`🔄 ${message}`);
                                    }
                                },
                                onCombinationComplete: (summary) => {
                                    logger.info(
                                        `✅ Combination ${summary.combinationId} completed: ${summary.successfulRuns}/${summary.totalRuns} successful (${(summary.successRate * 100).toFixed(1)}%)`
                                    );
                                },
                                onResourceWarning: (alert) => {
                                    logger.warn(
                                        `⚠️  Resource ${alert.resource} at ${alert.currentUsage.toFixed(1)}%: ${alert.message}`
                                    );
                                    if (alert.recommendation) {
                                        logger.info(`💡 Recommendation: ${alert.recommendation}`);
                                    }
                                },
                            });

                            // Report final results
                            const successfulRuns = results.filter((r) => r.success).length;
                            const failedRuns = results.length - successfulRuns;
                            const successRate = results.length > 0 ? (successfulRuns / results.length) * 100 : 0;

                            logger.info('\n🎉 Matrix Execution Complete!');
                            logger.info(`📊 Results Summary:`);
                            logger.info(`   Total runs: ${results.length}`);
                            logger.info(`   Successful: ${successfulRuns}`);
                            logger.info(`   Failed: ${failedRuns}`);
                            logger.info(`   Success rate: ${successRate.toFixed(1)}%`);
                            logger.info(`📁 Results saved to: ${outputDir}`);

                            // Exit with appropriate code
                            process.exit(failedRuns === 0 ? 0 : 1);
                        }
                    } catch (error) {
                        logger.error('❌ An error occurred during matrix analysis:');
                        logger.error(error instanceof Error ? error.message : String(error));
                        if (options.verbose && error instanceof Error && error.stack) {
                            logger.error(`Stack trace: ${error.stack}`);
                        }
                        logger.info('💡 Use --verbose for more detailed error information.');
                        process.exit(1);
                    }
                }
            )
    );

export default scenario;
