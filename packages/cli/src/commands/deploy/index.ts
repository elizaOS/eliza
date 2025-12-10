/**
 * Deploy Command - Deploy ElizaOS projects to ElizaOS Cloud or AWS ECS
 */

import { Command } from 'commander';
import { logger } from '@elizaos/core';
import * as clack from '@clack/prompts';
import colors from 'yoctocolors';
import { handleError } from '@/src/utils';
import { deployProject } from './actions/deploy';
import type { DeployOptions, DeployTarget } from './types';
import { cloudAccountService } from '@/src/services';

/**
 * Prompt user to select deployment target
 */
async function selectDeployTarget(): Promise<DeployTarget> {
  const hasCloudAccount = await cloudAccountService.hasValidCloudAccount();

  clack.intro(colors.inverse(' 🚀 ElizaOS Deployment '));

  if (!hasCloudAccount) {
    clack.note(
      [
        `${colors.bold('ElizaOS Cloud')} offers the easiest deployment experience:`,
        '',
        `  ${colors.green('✓')} One-click deployment`,
        `  ${colors.green('✓')} Automatic HTTPS & domain`,
        `  ${colors.green('✓')} Built-in monitoring & logs`,
        `  ${colors.green('✓')} Pay only for what you use`,
        '',
        colors.dim('Run "elizaos login" first to connect your cloud account.'),
      ].join('\n'),
      'Recommended: ElizaOS Cloud'
    );
  }

  const target = await clack.select({
    message: 'Where would you like to deploy?',
    options: [
      {
        label: `ElizaOS Cloud${hasCloudAccount ? colors.green(' ✓ Connected') : ''}`,
        value: 'cloud' as DeployTarget,
        hint: hasCloudAccount
          ? 'Fastest deployment with managed infrastructure'
          : 'Login required - run "elizaos login" first',
      },
      {
        label: 'AWS ECS (Self-managed)',
        value: 'aws-ecs' as DeployTarget,
        hint: 'Deploy to your own AWS account',
      },
    ],
    initialValue: hasCloudAccount ? ('cloud' as DeployTarget) : ('aws-ecs' as DeployTarget),
  });

  if (clack.isCancel(target)) {
    clack.cancel('Deployment cancelled.');
    process.exit(0);
  }

  // If user selected cloud but doesn't have an account, offer to set one up
  if (target === 'cloud' && !hasCloudAccount) {
    const setupChoice = await clack.confirm({
      message: 'You need to login to ElizaOS Cloud first. Would you like to login now?',
      initialValue: true,
    });

    if (clack.isCancel(setupChoice) || !setupChoice) {
      clack.log.info('You can login later with: elizaos login');
      return 'aws-ecs';
    }

    const loginSuccess = await cloudAccountService.initiateCloudLogin();
    if (!loginSuccess) {
      clack.log.warn('Cloud login failed. Falling back to AWS ECS deployment.');
      return 'aws-ecs';
    }

    clack.log.success('Successfully connected to ElizaOS Cloud!');
  }

  return target as DeployTarget;
}

export const deploy = new Command()
  .name('deploy')
  .description('Deploy ElizaOS project to ElizaOS Cloud or AWS ECS')
  .option('-n, --name <name>', 'Name for the deployment')
  .option('--project-name <name>', 'Project name (defaults to directory name)')
  .option('-t, --target <target>', 'Deployment target: cloud or aws-ecs')
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

      // Determine deployment target
      let target = options.target;
      if (!target) {
        // Interactive mode - prompt for target
        target = await selectDeployTarget();
      }

      // For cloud target, ensure we have valid credentials
      if (target === 'cloud') {
        const hasCloudAccount = await cloudAccountService.hasValidCloudAccount();
        if (!hasCloudAccount && !options.apiKey) {
          logger.error(
            { src: 'cli', command: 'deploy' },
            'ElizaOS Cloud deployment requires authentication. Run "elizaos login" first.'
          );
          process.exit(1);
        }
        logger.info({ src: 'cli', command: 'deploy', target: 'cloud' }, 'Deploying to ElizaOS Cloud');
      } else {
        logger.info({ src: 'cli', command: 'deploy', target: 'aws-ecs' }, 'Deploying to AWS ECS');
      }

      // Pass target to deploy function
      options.target = target;
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

      if (result.agentId) {
        logger.info(
          { src: 'cli', command: 'deploy', agentId: result.agentId },
          'ERC-8004 Agent ID'
        );
      }
    } catch (error: unknown) {
      handleError(error);
      process.exit(1);
    }
  });

export * from './types';
