import { Command } from 'commander';
import * as yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { logger as elizaLogger } from '@elizaos/core';
import { ScenarioSchema, Scenario } from "../scenario/src/schema"
import { LocalEnvironmentProvider } from '../scenario/src/LocalEnvironmentProvider';
import { E2BEnvironmentProvider } from '../scenario/src/E2BEnvironmentProvider';
import { EnvironmentProvider } from '../scenario/src/providers';
import { createScenarioServerAndAgent } from '../scenario/src/runtime-factory';

import { MockEngine } from './src/MockEngine';
import { EvaluationEngine } from './src/EvaluationEngine';
import { Reporter } from './src/Reporter';
import { PluginParser } from './src/plugin-parser';

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
                            pluginResult.errors.forEach(error => logger.error(`  - ${error}`));
                            process.exit(1);
                        }

                        if (pluginResult.warnings.length > 0) {
                            logger.warn('Plugin warnings:');
                            pluginResult.warnings.forEach(warning => logger.warn(`  - ${warning}`));
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
                    const scenarioPlugins = Array.isArray((scenario as any).plugins) ? (scenario as any).plugins as string[] : [];
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
                            const created = await createScenarioServerAndAgent(null, 3000);
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
                                const evaluationResults = await evaluationEngine.runEvaluations(step.evaluations, result);
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
                        finalStatus = allEvaluationResults.every(res => res.success);
                    } else if (scenario.judgment?.strategy === 'any_pass') {
                        finalStatus = allEvaluationResults.some(res => res.success);
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
    );

export default scenario;