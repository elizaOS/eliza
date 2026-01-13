#!/usr/bin/env node
/**
 * Main command line interface
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as process from 'process';
import { AgentConfig } from '../agent/agents';
import { ModelConfig } from '../agent/models';
import { GithubIssue, TextProblemStatement } from '../agent/problem-statement';
import { GithubRepoConfig, LocalRepoConfig } from '../environment/repo';
import { EnvironmentConfig } from '../environment/swe-env';
import { RunBatch, RunBatchConfig } from './run-batch';
import { RunSingle, RunSingleActionConfig, RunSingleConfig } from './run-single';
// Removed unused CLIConfig import

const program = new Command();

program.name('sweagent').description('SWE-agent: AI software engineering agent').version('1.0.0');

// Run command
program
  .command('run')
  .alias('r')
  .description('Run swe-agent on a single problem statement instance, for example a github issue')
  .option('--config <path>', 'Load additional configuration file')
  .option('--agent.model.name <name>', 'Model to use')
  .option('--env.repo.github_url <url>', 'GitHub repository URL')
  .option('--env.repo.path <path>', 'Local repository path')
  .option('--problem_statement.github_url <url>', 'GitHub issue URL')
  .option('--problem_statement.path <path>', 'Path to problem statement file')
  .option('--output_dir <dir>', 'Output directory', 'DEFAULT')
  .option('--actions.open_pr', 'Open a PR with the patch')
  .option('--actions.apply_patch_locally', 'Apply patch to local repository')
  .option('--format <type>', 'Output format (text/json)', 'text')
  .option('--verbose', 'Enable verbose mode')
  .action(async (options) => {
    try {
      // Parse options into config
      const config: Partial<RunSingleConfig> = {
        outputDir: options.output_dir,
      };

      // Handle nested options
      if (options['agent.model.name']) {
        config.agent = {
          ...config.agent,
          model: { name: options['agent.model.name'] } as ModelConfig,
        } as AgentConfig;
      }

      if (options['env.repo.github_url']) {
        config.env = {
          ...config.env,
          repo: {
            type: 'github',
            githubUrl: options['env.repo.github_url'],
          } as GithubRepoConfig,
        } as EnvironmentConfig;
      }

      if (options['env.repo.path']) {
        config.env = {
          ...config.env,
          repo: {
            type: 'local',
            path: options['env.repo.path'],
          } as LocalRepoConfig,
        } as EnvironmentConfig;
      }

      if (options['problem_statement.github_url']) {
        config.problemStatement = new GithubIssue({
          githubUrl: options['problem_statement.github_url'],
        });
      }

      if (options['problem_statement.path']) {
        // Load text from file
        const text = fs.existsSync(options['problem_statement.path'])
          ? fs.readFileSync(options['problem_statement.path'], 'utf-8')
          : '';
        config.problemStatement = new TextProblemStatement({
          text,
          id: 'problem_statement',
        });
      }

      if (options['actions.open_pr']) {
        config.actions = {
          ...config.actions,
          openPr: true,
        } as RunSingleActionConfig;
      }

      if (options['actions.apply_patch_locally']) {
        config.actions = {
          ...config.actions,
          applyPatchLocally: true,
        } as RunSingleActionConfig;
      }

      const runSingle = await RunSingle.fromConfig(config as RunSingleConfig);
      await runSingle.run();
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

// Run-batch command
program
  .command('run-batch')
  .alias('b')
  .description('Run swe-agent on a batch of problem statements, e.g., on SWE-Bench')
  .option('--instances.type <type>', 'Instance source type (swe_bench, file, huggingface)')
  .option('--instances.subset <subset>', 'SWE-bench subset (lite, verified, full, multimodal, multilingual)')
  .option('--instances.split <split>', 'Dataset split (dev, test)')
  .option('--instances.slice <slice>', 'Slice specification (e.g., :50)')
  .option('--instances.shuffle', 'Shuffle instances')
  .option('--instances.filter <regex>', 'Filter instances by regex')
  .option('--instances.evaluate', 'Run SWE-bench evaluation with sb-cli')
  .option('--instances.path <path>', 'Path to instances file')
  .option('--instances.dataset_name <name>', 'HuggingFace dataset name')
  .option('--config <path>', 'Load additional configuration file')
  .option('--agent.model.name <name>', 'Model to use')
  .option('--agent.model.per_instance_cost_limit <limit>', 'Cost limit per instance')
  .option('--output_dir <dir>', 'Output directory', 'DEFAULT')
  .option('--num_workers <n>', 'Number of parallel workers', '1')
  .option('--redo_existing', 'Redo existing trajectories')
  .option('--random_delay_multiplier <n>', 'Random delay multiplier for workers', '0.3')
  .action(async (options) => {
    try {
      // Parse options into config
      const config: Partial<RunBatchConfig> = {
        outputDir: options.output_dir,
        numWorkers: parseInt(options.num_workers, 10),
        redoExisting: options.redo_existing,
        randomDelayMultiplier: parseFloat(options.random_delay_multiplier || '0.3'),
      };

      // Handle instance configuration
      if (options['instances.type'] === 'swe_bench') {
        config.instances = {
          type: 'swe_bench',
          subset: options['instances.subset'] || 'lite',
          split: options['instances.split'] || 'dev',
          filter: options['instances.filter'] || '.*',
          slice: options['instances.slice'],
          shuffle: options['instances.shuffle'],
          evaluate: options['instances.evaluate'] || false,
        };
      } else if (options['instances.type'] === 'file') {
        config.instances = {
          type: 'file',
          path: options['instances.path'],
          filter: options['instances.filter'] || '.*',
          slice: options['instances.slice'],
          shuffle: options['instances.shuffle'],
        };
      } else if (options['instances.type'] === 'huggingface') {
        throw new Error('HuggingFace instances are not yet implemented');
      }

      // Handle agent configuration
      if (options['agent.model.name']) {
        if (!config.agent || config.agent.type === 'retry') {
          // For retry agents or if agent not configured, create a default agent config
          config.agent = {
            type: 'default',
            model: { name: options['agent.model.name'] } as ModelConfig,
          } as AgentConfig;
        } else {
          const existingModel = config.agent.model || ({} as ModelConfig);
          config.agent = {
            ...config.agent,
            model: {
              ...existingModel,
              name: options['agent.model.name'],
            } as ModelConfig,
          } as AgentConfig;
        }
      }

      if (options['agent.model.per_instance_cost_limit']) {
        if (!config.agent || config.agent.type === 'retry') {
          config.agent = {
            type: 'default',
            model: {
              name: 'gpt-4',
              perInstanceCostLimit: parseFloat(options['agent.model.per_instance_cost_limit']),
            } as ModelConfig,
          } as AgentConfig;
        } else {
          const existingModel = config.agent.model || ({} as ModelConfig);
          config.agent = {
            ...config.agent,
            model: {
              ...existingModel,
              perInstanceCostLimit: parseFloat(options['agent.model.per_instance_cost_limit']),
            } as ModelConfig,
          } as AgentConfig;
        }
      }

      const runBatch = RunBatch.fromConfig(config as RunBatchConfig);
      await runBatch.main();
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

// Merge-preds command
program
  .command('merge-preds')
  .description('Merge multiple prediction files into a single file')
  .argument('<directories...>', 'Directories containing predictions')
  .option('--output <path>', 'Output file')
  .action(async (directories, options) => {
    try {
      const { mergePredictions } = await import('./merge-predictions');
      mergePredictions(directories, options.output);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

// Inspector command
program
  .command('inspect')
  .alias('i')
  .description('Open a single trajectory file in a terminal-based viewer')
  .argument('[trajectory_path]', 'Path to trajectory file or directory', '.')
  .option('-d, --data_path <path>', 'Path to the data file to load gold patches from')
  .action(async (trajectoryPath, options) => {
    try {
      const { inspectorCli } = await import('./inspector-cli');
      await inspectorCli(trajectoryPath, options.data_path);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

// Quick-stats command
program
  .command('quick-stats')
  .alias('qs')
  .description('Calculate quick stats from a directory of trajectories')
  .argument('[directory]', 'Directory to search for .traj files', '.')
  .action(async (directory) => {
    try {
      const { quickStats } = await import('./quick-stats');
      const result = await quickStats(directory);
      console.log(result);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

// Remove-unfinished command
program
  .command('remove-unfinished')
  .alias('ru')
  .description('Remove unfinished trajectories')
  .option('--base_dir <dir>', 'Base directory', '.')
  .option('--remove', 'Actually remove unfinished trajectories')
  .action(async (options) => {
    try {
      const { removeUnfinished } = await import('./remove-unfinished');
      await removeUnfinished(options.base_dir, !options.remove);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

// Compare-runs command
program
  .command('compare-runs')
  .alias('cr')
  .description('Compare multiple run results')
  .argument('<paths...>', 'Paths to results.json files or directories')
  .option('--show-same', 'Show instances with same results')
  .action(async (paths, options) => {
    try {
      const { compareRuns } = await import('./compare-runs');
      await compareRuns(paths, options.showSame);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

// Extract-pred command
program
  .command('extract-pred')
  .description('Extract prediction from a trajectory file')
  .argument('<traj_path>', 'Path to trajectory file')
  .action(async (trajPath) => {
    try {
      const { extractPred } = await import('./extract-pred');
      extractPred(trajPath);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

// Traj-to-demo command
program
  .command('traj-to-demo')
  .description('Convert a trajectory file to a demo file')
  .argument('<traj_path>', 'Path to trajectory file')
  .option('--output_dir <dir>', 'Output directory for action demos', './demos')
  .option('--suffix <suffix>', 'Suffix for the output file', '')
  .option('--overwrite', 'Overwrite existing files')
  .option('--include_user', 'Include user responses (computer)')
  .action(async (trajPath, options) => {
    try {
      const { trajToDemo } = await import('./run-traj-to-demo');
      trajToDemo(trajPath, options.output_dir, options.suffix, options.overwrite, options.include_user);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

// Run-replay command
program
  .command('run-replay')
  .description('Replay a trajectory file')
  .requiredOption('--traj_path <path>', 'Path to trajectory file')
  .option('--deployment <type>', 'Override deployment type')
  .option('--output_dir <dir>', 'Output directory', 'DEFAULT')
  .option('--env_var_path <path>', 'Path to .env file')
  .option('--update_config <paths...>', 'Additional config files to merge')
  .option('--forward_only', 'Only execute forward passes')
  .option('--n_forward <number>', 'Number of forward passes', '0')
  .action(async (options) => {
    try {
      const { RunReplay } = await import('./run-replay');
      const replay = RunReplay.fromConfig({
        trajPath: options.traj_path,
        deployment: options.deployment,
        outputDir: options.output_dir,
        envVarPath: options.env_var_path,
        updateConfig: options.update_config || [],
      });
      await replay.main();
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

// Shell command
program
  .command('shell')
  .alias('sh')
  .description('Run SWE-agent in semi-interactive mode')
  .option('-r, --repo <path>', 'Path to the repository')
  .option('--config <path>', 'Path to the agent config file', 'config/exotic/default_shell.yaml')
  .option('-p <statement>', 'Problem statement', '')
  .action(async (options) => {
    try {
      const { runShellFromConfig } = await import('./run-shell');
      await runShellFromConfig({
        repo: options.repo,
        config: options.config,
        problemStatement: options.p,
      });
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

// Parse arguments
program.parse(process.argv);

// If no arguments provided, show help and exit with error
if (process.argv.length === 2) {
  program.outputHelp();
  process.exit(1);
}
