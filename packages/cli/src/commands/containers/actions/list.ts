/**
 * List Containers Action
 */

import { logger } from '@elizaos/core';
import type { ContainersOptions, Container } from '../types';

export async function listContainersAction(options: ContainersOptions) {
  try {
    const apiKey = options.apiKey || process.env.ELIZA_SERVER_AUTH_TOKEN;
    const apiUrl = options.apiUrl || 'https://www.elizacloud.ai';

    if (!apiKey) {
      logger.error(
        '❌ Error: API key is required. Use --api-key or set ELIZA_SERVER_AUTH_TOKEN environment variable.'
      );
      process.exit(1);
    }

    logger.info('📋 Fetching container list...');

    const response = await fetch(`${apiUrl}/api/v1/containers`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Failed to fetch containers: ${response.statusText}`);
    }

    const result = await response.json();
    const containers: Container[] = result.data || [];

    if (options.json) {
      console.log(JSON.stringify(containers, null, 2));
      return;
    }

    if (containers.length === 0) {
      logger.info('\n📦 No containers found.\n');
      return;
    }

    logger.info(`\n📦 Found ${containers.length} container(s):\n`);

    for (const container of containers) {
      console.log(`  ID: ${container.id}`);
      console.log(`  Name: ${container.name}`);
      console.log(`  Project: ${container.project_name}`);
      console.log(`  Status: ${container.status}`);
      console.log(`  CPU/Memory: ${container.cpu} / ${container.memory}MB`);
      console.log(`  Port: ${container.port}`);
      if (container.load_balancer_url) {
        console.log(`  URL: ${container.load_balancer_url}`);
      }
      if (container.cloudformation_stack_name) {
        console.log(`  Stack: ${container.cloudformation_stack_name}`);
      }
      console.log(`  Created: ${new Date(container.created_at).toLocaleString()}`);
      console.log(`  Type: ${container.is_update === 'true' ? 'Update' : 'Fresh'}`);
      console.log('');
    }
  } catch (error: unknown) {
    logger.error(
      `❌ Error: ${error instanceof Error ? error.message : 'Failed to list containers'}`
    );
    process.exit(1);
  }
}
