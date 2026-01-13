/**
 * Main run module CLI
 * Converted from sweagent/run/run.py
 */

import { Command } from 'commander';
import { runFromConfig as runSingleFromConfig } from './run-single';
import { runBatchFromConfig } from './run-batch';
import { runReplayFromConfig, RunReplayConfig } from './run-replay';
import { getLogger } from '../utils/log';
import { loadFile } from '../utils/files';
import { RunSingleConfig, RunBatchConfig } from './types';
import { TextProblemStatement } from '../agent/problem-statement';

const logger = getLogger('run', '🏃');

/**
 * Main run function - determines which run mode to use
 */
export async function run(args: string[]): Promise<void> {
  const program = new Command();

  program.name('swe-agent').description('SWE-agent - AI Software Engineering Agent').version('1.0.0');

  // Single run command
  program
    .command('single')
    .description('Run agent on a single instance')
    .option('-c, --config <path>', 'Configuration file path')
    .option('-e, --env <json>', 'Environment configuration (JSON)')
    .option('-a, --agent <json>', 'Agent configuration (JSON)')
    .option('-p, --problem <text>', 'Problem statement text')
    .option('-o, --output <dir>', 'Output directory', 'DEFAULT')
    .action(async (options) => {
      logger.info('Running single instance');

      // Load config
      let config: Partial<RunSingleConfig> = {};
      if (options.config) {
        config = loadFile(options.config) as RunSingleConfig;
      }

      // Override with command line options
      if (options.env) {
        config.env = JSON.parse(options.env);
      }
      if (options.agent) {
        config.agent = JSON.parse(options.agent);
      }
      if (options.problem) {
        config.problemStatement = new TextProblemStatement({
          text: options.problem,
        });
      }
      if (options.output) {
        config.outputDir = options.output;
      }

      await runSingleFromConfig(config as RunSingleConfig);
    });

  // Batch run command
  program
    .command('batch')
    .description('Run agent on multiple instances')
    .option('-c, --config <path>', 'Configuration file path')
    .option('-i, --instances <path>', 'Instances file path')
    .option('-a, --agent <json>', 'Agent configuration (JSON)')
    .option('-o, --output <dir>', 'Output directory', 'DEFAULT')
    .option('-w, --workers <n>', 'Number of parallel workers', '1')
    .option('--redo', 'Redo existing instances')
    .action(async (options) => {
      logger.info('Running batch');

      // Load config
      let config: Partial<RunBatchConfig> = {};
      if (options.config) {
        config = loadFile(options.config) as RunBatchConfig;
      }

      // Override with command line options
      if (options.instances) {
        config.instances = {
          type: 'file',
          path: options.instances,
        };
      }
      if (options.agent) {
        config.agent = JSON.parse(options.agent);
      }
      if (options.output) {
        config.outputDir = options.output;
      }
      if (options.workers) {
        config.numWorkers = parseInt(options.workers);
      }
      if (options.redo) {
        config.redoExisting = true;
      }

      await runBatchFromConfig(config as RunBatchConfig);
    });

  // Replay command
  program
    .command('replay')
    .description('Replay an agent trajectory')
    .argument('<traj-path>', 'Path to trajectory file')
    .option('-o, --output <dir>', 'Output directory', 'DEFAULT')
    .option('-d, --deployment <json>', 'Deployment configuration (JSON)')
    .action(async (trajPath, options) => {
      logger.info('Replaying trajectory');

      const config: Partial<RunReplayConfig> = {
        trajPath,
      };

      if (options.output) {
        config.outputDir = options.output;
      }
      if (options.deployment) {
        config.deployment = JSON.parse(options.deployment);
      }

      await runReplayFromConfig(config as RunReplayConfig);
    });

  // Parse arguments
  await program.parseAsync(args);
}

// If running as main module
if (require.main === module) {
  run(process.argv).catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
}
