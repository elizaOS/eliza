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
        logger.error({ src: 'cli', command: 'deploy', port: options.port }, 'Invalid port');
        process.exit(1);
      }

      if (
        options.desiredCount &&
        (isNaN(options.desiredCount) || options.desiredCount < 1 || options.desiredCount > 10)
      ) {
        logger.error(
          { src: 'cli', command: 'deploy', desiredCount: options.desiredCount },
          'Invalid desired count'
        );
        process.exit(1);
      }

      if (options.cpu && (options.cpu < 256 || options.cpu > 2048)) {
        logger.error({ src: 'cli', command: 'deploy', cpu: options.cpu }, 'Invalid CPU value');
        process.exit(1);
      }

      if (
        options.memory &&
        (isNaN(options.memory) || options.memory < 512 || options.memory > 2048)
      ) {
        logger.error(
          { src: 'cli', command: 'deploy', memory: options.memory },
          'Invalid memory value'
        );
        process.exit(1);
      }

      const result = await deployProject(options);

      if (!result.success) {
        logger.error({ src: 'cli', command: 'deploy', error: result.error }, 'Deployment failed');
        process.exit(1);
      }

      logger.success({ src: 'cli', command: 'deploy' }, 'Deployment completed');

      if (result.containerId) {
        logger.info(
          { src: 'cli', command: 'deploy', containerId: result.containerId },
          'Container created'
        );
      }

      if (result.serviceArn) {
        logger.info(
          { src: 'cli', command: 'deploy', serviceArn: result.serviceArn },
          'ECS Service'
        );
      }

      if (result.taskDefinitionArn) {
        logger.info(
          { src: 'cli', command: 'deploy', taskDefinitionArn: result.taskDefinitionArn },
          'Task Definition'
        );
      }

      if (result.url) {
        logger.info({ src: 'cli', command: 'deploy', url: result.url }, 'Service URL');
      }
    } catch (error: unknown) {
      handleError(error);
      process.exit(1);
    }
  });

export * from './types';
