import type { OptionValues } from 'commander';
import { checkServer, handleError } from '@/src/utils';
import { getAgents } from './validation';

/**
 * List command implementation - displays available agents
 */
export async function listAgents(opts: OptionValues): Promise<void> {
  try {
    // API Endpoint: GET /agents
    const agents = await getAgents(opts);

    // Format data for table
    const agentData = agents.map((agent) => ({
      Name: agent.name,
      ID: agent.id,
      Status: agent.status || 'unknown',
    }));

    if (opts.json) {
      console.info(JSON.stringify(agentData, null, 2));
    } else {
      console.info('\nAvailable agents:');
      if (agentData.length === 0) {
        console.info('No agents found');
      } else {
        console.table(agentData);
      }
    }

    return;
  } catch (error) {
    await checkServer(opts);
    handleError(error);
  }
}
