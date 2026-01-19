/**
 * List Containers Action
 */

import { logger } from '@elizaos/core';
import type { ContainersOptions, Container } from '../types';

interface QuotaResponse {
  success: boolean;
  data?: {
    credits: {
      balance: number;
    };
    billing?: {
      model: string;
      dailyCostPerContainer: number;
      monthlyEquivalent: number;
      currentDailyBurn: number;
      runningContainers: number;
      daysOfRunway: number | null;
    };
  };
}

export async function listContainersAction(options: ContainersOptions) {
  try {
    const apiKey = options.apiKey || process.env.ELIZAOS_API_KEY;
    const apiUrl = options.apiUrl || 'https://www.elizacloud.ai';

    if (!apiKey) {
      logger.error(
        { src: 'cli', command: 'containers-list' },
        'API key is required. Use --api-key or set ELIZAOS_API_KEY environment variable'
      );
      process.exit(1);
    }

    logger.info({ src: 'cli', command: 'containers-list' }, 'Fetching container list');

    // Fetch containers and quota info in parallel
    const [containerResponse, quotaResponse] = await Promise.all([
      fetch(`${apiUrl}/api/v1/containers`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }),
      fetch(`${apiUrl}/api/v1/containers/quota`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }),
    ]);

    if (!containerResponse.ok) {
      const errorData = await containerResponse.json().catch(() => ({}));
      throw new Error(
        errorData.error || `Failed to fetch containers: ${containerResponse.statusText}`
      );
    }

    const result = await containerResponse.json();
    const containers: Container[] = result.data || [];

    // Get quota/billing info
    let quotaData: QuotaResponse['data'] | null = null;
    if (quotaResponse.ok) {
      const quota: QuotaResponse = await quotaResponse.json();
      quotaData = quota.data || null;
    }

    if (options.json) {
      console.log(JSON.stringify({ containers, billing: quotaData?.billing }, null, 2));
      return;
    }

    // Show billing summary if available
    if (quotaData?.billing) {
      const { billing, credits } = quotaData;
      console.log('');
      console.log('═══════════════════════════════════════════════════════════');
      console.log('                    BILLING SUMMARY                        ');
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`  Billing Model:          ${billing.model.toUpperCase()}`);
      console.log(
        `  Cost per Container:     $${billing.dailyCostPerContainer.toFixed(2)}/day (~$${billing.monthlyEquivalent.toFixed(2)}/month)`
      );
      console.log(`  Running Containers:     ${billing.runningContainers}`);
      console.log(`  Current Daily Burn:     $${billing.currentDailyBurn.toFixed(2)}/day`);
      console.log(`  Credit Balance:         $${credits.balance.toFixed(2)}`);
      if (billing.daysOfRunway !== null) {
        const runwayStatus = billing.daysOfRunway < 7 ? ' ⚠️ LOW' : '';
        console.log(`  Days of Runway:         ${billing.daysOfRunway} days${runwayStatus}`);
      }
      console.log('═══════════════════════════════════════════════════════════');
      console.log('');
    }

    if (containers.length === 0) {
      logger.info({ src: 'cli', command: 'containers-list' }, 'No containers found');
      return;
    }

    logger.info(
      { src: 'cli', command: 'containers-list', count: containers.length },
      'Found containers'
    );

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
      // Show billing info for this container if available
      if (quotaData?.billing) {
        console.log(`  Daily Cost: $${quotaData.billing.dailyCostPerContainer.toFixed(2)}/day`);
      }
      console.log('');
    }
  } catch (error: unknown) {
    logger.error(
      {
        src: 'cli',
        command: 'containers-list',
        error: error instanceof Error ? error.message : 'Failed to list containers',
      },
      'Error listing containers'
    );
    process.exit(1);
  }
}
