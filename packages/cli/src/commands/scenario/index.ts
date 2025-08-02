import { Command } from 'commander';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { logger as elizaLogger } from '@elizaos/core';
import { ScenarioSchema, Scenario } from '../../scenarios/schema';
import { LocalEnvironmentProvider } from '../../scenarios/LocalEnvironmentProvider';
import { E2BEnvironmentProvider } from '../../scenarios/E2BEnvironmentProvider';
import { EnvironmentProvider } from '../../scenarios/providers';
import { createE2BRuntime } from '../../scenarios/runtime-factory';

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

                    // Determine environment provider based on scenario type
                    if (scenario.environment.type === 'e2b') {
                        runtime = await createE2BRuntime();
                        provider = new E2BEnvironmentProvider(runtime);
                        logger.info('Using E2B sandbox environment');
                    } else if (scenario.environment.type === 'local') {
                        provider = new LocalEnvironmentProvider();
                        logger.info('Using local environment');
                    } else {
                        logger.error(`Unsupported environment type: '${scenario.environment.type}'`);
                        process.exit(1);
                    }

                    logger.info(`Setting up '${scenario.environment.type}' environment...`);
                    await provider.setup(scenario);
                    logger.info('Executing run block...');
                    const results = await provider.run(scenario);
                    console.log('--- Execution Results ---');
                    results.forEach((result, idx) => {
                        console.log(`Step ${idx + 1}:`);
                        console.log(JSON.stringify(result, null, 2));
                    });
                    console.log('-------------------------');
                } catch (error) {
                    logger.error('An error occurred during scenario execution:', error);
                    process.exit(1);
                } finally {
                    if (provider) {
                        logger.info('Tearing down environment...');
                        await provider.teardown();
                    }
                    if (runtime) {
                        // Explicitly stop the E2B service to ensure clean shutdown
                        const e2bService = runtime.getService('e2b');
                        if (e2bService && typeof e2bService.stop === 'function') {
                            logger.info('Stopping E2B service...');
                            await e2bService.stop();
                        }
                        await runtime.close();
                        logger.info('Runtime shutdown complete');
                    }
                    // Force exit to ensure clean termination
                    process.exit(0);
                }
            })
    );

export default scenario;