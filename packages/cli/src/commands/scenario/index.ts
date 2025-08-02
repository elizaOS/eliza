import { Command } from 'commander';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { logger as elizaLogger } from '@elizaos/core';

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
                try {
                    const fullPath = path.resolve(filePath);
                    logger.info(`Attempting to read scenario file from: ${fullPath}`);
                    if (!fs.existsSync(fullPath)) {
                        logger.error(`Error: File not found at '${fullPath}'`);
                        process.exit(1);
                    }
                    const fileContents = fs.readFileSync(fullPath, 'utf8');
                    const scenario = yaml.load(fileContents);
                    console.log('--- Parsed Scenario Content ---');
                    console.log(JSON.stringify(scenario, null, 2));
                    console.log('-----------------------------');
                    logger.info('Scenario file parsed successfully.');
                } catch (error) {
                    logger.error('An error occurred during scenario execution:', error);
                    process.exit(1);
                }
            })
    );

export default scenario;