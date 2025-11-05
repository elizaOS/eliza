/**
 * Delete Container Action
 */

import { logger } from '@elizaos/core';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { DeleteContainerOptions, Container } from '../types';

async function confirmDeletion(containerName: string, projectName: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      `⚠️  Are you sure you want to delete "${containerName}" (project: ${projectName})? This action cannot be undone. (y/N) `,
      (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      }
    );
  });
}

export async function deleteContainerAction(
  containerId: string | undefined,
  options: DeleteContainerOptions
) {
  try {
    const apiKey = options.apiKey || process.env.ELIZA_SERVER_AUTH_TOKEN;
    const apiUrl = options.apiUrl || 'https://www.elizacloud.ai';

    if (!apiKey) {
      logger.error(
        '❌ Error: API key is required. Use --api-key or set ELIZA_SERVER_AUTH_TOKEN environment variable.'
      );
      process.exit(1);
    }

    // Auto-detect container if not provided
    let targetContainerId = containerId;
    let containerName = '';
    let projectName = '';

    if (!targetContainerId) {
      projectName = options.projectName || path.basename(process.cwd());
      logger.info(`🔍 Auto-detecting container for project "${projectName}"...`);

      // Fetch all containers
      const listResponse = await fetch(`${apiUrl}/api/v1/containers`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!listResponse.ok) {
        const errorData = await listResponse.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to fetch containers');
      }

      const listResult = await listResponse.json();
      const containers: Container[] = listResult.data || [];

      // Find container with matching project_name
      const matchingContainer = containers.find((c) => c.project_name === projectName);

      if (!matchingContainer) {
        logger.error(`❌ Error: No container found for project "${projectName}"`);
        logger.info(`\n💡 Available projects:`);
        const uniqueProjects = [...new Set(containers.map((c) => c.project_name))];
        uniqueProjects.forEach((proj) => {
          logger.info(`   - ${proj}`);
        });
        logger.info(`\nRun "elizaos containers list" to see all containers.`);
        process.exit(1);
      }

      targetContainerId = matchingContainer.id;
      containerName = matchingContainer.name;
      logger.info(`✅ Found container: ${containerName} (${targetContainerId})`);
    }

    if (!options.force && containerName) {
      const confirmed = await confirmDeletion(containerName, projectName);
      if (!confirmed) {
        logger.info('❌ Deletion cancelled.');
        return;
      }
    } else if (!options.force) {
      // If container ID was provided directly, we need to fetch container details for confirmation
      const detailsResponse = await fetch(`${apiUrl}/api/v1/containers/${targetContainerId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (detailsResponse.ok) {
        const detailsResult = await detailsResponse.json();
        const container: Container = detailsResult.data;
        const confirmed = await confirmDeletion(container.name, container.project_name);
        if (!confirmed) {
          logger.info('❌ Deletion cancelled.');
          return;
        }
      }
    }

    logger.info(`🗑️  Deleting container ${targetContainerId}...`);

    const response = await fetch(`${apiUrl}/api/v1/containers/${targetContainerId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Failed to delete container: ${response.statusText}`);
    }

    logger.info(`✅ Container ${targetContainerId} deleted successfully.`);
    logger.info('ℹ️  Note: CloudFormation stack deletion may take a few minutes to complete.');
  } catch (error: unknown) {
    logger.error(
      `❌ Error: ${error instanceof Error ? error.message : 'Failed to delete container'}`
    );
    process.exit(1);
  }
}
