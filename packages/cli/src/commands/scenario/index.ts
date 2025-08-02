import { Command } from 'commander';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { logger as elizaLogger } from '@elizaos/core';
import { ScenarioSchema, Scenario } from '../../scenarios/schema';
import { LocalEnvironmentProvider } from '../../scenarios/LocalEnvironmentProvider';
import { EnvironmentProvider } from '../../scenarios/providers';

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
                    if (scenario.environment.type === 'local') {
                        provider = new LocalEnvironmentProvider();
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
                }
            })
    );

export default scenario;