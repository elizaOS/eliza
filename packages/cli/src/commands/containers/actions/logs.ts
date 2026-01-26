/**
 * Get Container Logs Action
 */

import { logger } from '@elizaos/core';
import * as path from 'node:path';
import type { ContainerLogsOptions, Container } from '../types';

export async function getContainerLogsAction(
  containerId: string | undefined,
  options: ContainerLogsOptions
) {
  try {
    const apiKey = options.apiKey || process.env.ELIZAOS_API_KEY;
    const apiUrl = options.apiUrl || 'https://www.elizacloud.ai';

    if (!apiKey) {
      logger.error(
        { src: 'cli', command: 'containers-logs' },
        'API key is required. Use --api-key or set ELIZAOS_API_KEY environment variable'
      );
      process.exit(1);
    }

    // Auto-detect container if not provided
    let targetContainerId = containerId;

    if (!targetContainerId) {
      const projectName = options.projectName || path.basename(process.cwd());
      logger.info(
        { src: 'cli', command: 'containers-logs', projectName },
        'Auto-detecting container for project'
      );

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
        logger.error(
          { src: 'cli', command: 'containers-logs', projectName },
          'No container found for project'
        );
        logger.info({ src: 'cli', command: 'containers-logs' }, 'Available projects:');
        const uniqueProjects = [...new Set(containers.map((c) => c.project_name))];
        uniqueProjects.forEach((proj) => {
          logger.info({ src: 'cli', command: 'containers-logs', project: proj }, '   - ' + proj);
        });
        logger.info(
          { src: 'cli', command: 'containers-logs' },
          'Run "elizaos containers list" to see all containers'
        );
        process.exit(1);
      }

      targetContainerId = matchingContainer.id;
      logger.info(
        {
          src: 'cli',
          command: 'containers-logs',
          containerName: matchingContainer.name,
          containerId: targetContainerId,
        },
        'Found container'
      );
    }

    logger.info(
      { src: 'cli', command: 'containers-logs', containerId: targetContainerId },
      'Fetching logs for container'
    );

    const queryParams = new URLSearchParams();
    if (options.tail) {
      queryParams.append('tail', options.tail);
    }

    const response = await fetch(
      `${apiUrl}/api/v1/containers/${targetContainerId}/logs?${queryParams}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Failed to fetch logs: ${response.statusText}`);
    }

    const result = await response.json();
    const logs = result.data?.logs || [];

    if (logs.length === 0) {
      logger.info({ src: 'cli', command: 'containers-logs' }, 'No logs available yet');
      return;
    }

    console.log('\n📜 Container Logs:\n');
    console.log('─'.repeat(80));

    for (const logEntry of logs) {
      console.log(logEntry);
    }

    console.log('─'.repeat(80));
    console.log('');

    if (options.follow) {
      logger.info(
        { src: 'cli', command: 'containers-logs' },
        'Note: --follow mode requires WebSocket support (coming soon)'
      );
    }
  } catch (error: unknown) {
    logger.error(
      {
        src: 'cli',
        command: 'containers-logs',
        error: error instanceof Error ? error.message : 'Failed to fetch logs',
      },
      'Error fetching logs'
    );
    process.exit(1);
  }
}
