/**
 * Deploy Command - Deploy ElizaOS projects to AWS ECS
 */

import { Command } from 'commander';
import { logger } from '@elizaos/core';
import { handleError } from '@/src/utils';
import { deployProject } from './actions/deploy';
import type { DeployOptions } from './types';

export const deploy = new Command()
  .name('deploy')
  .description('Deploy ElizaOS project to AWS ECS (Elastic Container Service)')
  .option('-n, --name <name>', 'Name for the deployment')
  .option('--project-name <name>', 'Project name (defaults to directory name)')
  .option(
    '-p, --port <port>',
    'Port the container listens on',
    (value) => parseInt(value, 10),
    3000
  )
  .option(
    '--desired-count <count>',
    'Number of container instances to run',
    (value) => parseInt(value, 10),
    1
  )
  .option(
    '--cpu <units>',
    'CPU units (1792 = 1.75 vCPU, 87.5% of t4g.small 2 vCPUs)',
    (value) => parseInt(value, 10),
    1792
  )
  .option(
    '--memory <mb>',
    'Memory in MB (1792 MB = 1.75 GiB, 87.5% of t4g.small 2 GiB)',
    (value) => parseInt(value, 10),
    1792
  )
  .option('-k, --api-key <key>', 'ElizaOS Cloud API key')
  .option('-u, --api-url <url>', 'ElizaOS Cloud API URL', 'https://www.elizacloud.ai')
  .option(
    '-e, --env <KEY=VALUE>',
    'Environment variable (can be specified multiple times)',
    (value, previous: string[]) => {
      return previous.concat([value]);
    },
    []
  )
  .option('--skip-build', 'Skip Docker build and use existing image')
  .option('--image-uri <uri>', 'Use existing ECR image URI (requires --skip-build)')
  .option(
    '--platform <platform>',
    'Docker platform for build (e.g., linux/amd64, linux/arm64). Defaults to host platform.',
    undefined
  )
  .action(async (options: DeployOptions) => {
    try {
      // Validate numeric options
      if (isNaN(options.port!) || options.port! < 1 || options.port! > 65535) {
        logger.error('❌ Error: Port must be a number between 1 and 65535');
        process.exit(1);
      }

      if (
        options.desiredCount &&
        (isNaN(options.desiredCount) || options.desiredCount < 1 || options.desiredCount > 10)
      ) {
        logger.error('❌ Error: Desired count must be a number between 1 and 10');
        process.exit(1);
      }

      if (options.cpu && (options.cpu < 256 || options.cpu > 2048)) {
        logger.error('❌ Error: CPU must be one of: 256, 512, 1024, 2048, 4096');
        process.exit(1);
      }

      if (
        options.memory &&
        (isNaN(options.memory) || options.memory < 512 || options.memory > 2048)
      ) {
        logger.error('❌ Error: Memory must be at least 512 MB');
        process.exit(1);
      }

      const result = await deployProject(options);

      if (!result.success) {
        logger.error(`\n❌ Deployment failed: ${result.error}\n`);
        process.exit(1);
      }

      logger.info('\n✅ Deployment completed successfully!\n');

      if (result.containerId) {
        logger.info(`Container ID: ${result.containerId}`);
      }

      if (result.serviceArn) {
        logger.info(`ECS Service: ${result.serviceArn}`);
      }

      if (result.taskDefinitionArn) {
        logger.info(`Task Definition: ${result.taskDefinitionArn}`);
      }

      if (result.url) {
        logger.info(`URL: ${result.url}`);
      }

      logger.info('\n');
    } catch (error: unknown) {
      handleError(error);
      process.exit(1);
    }
  });

export * from './types';
