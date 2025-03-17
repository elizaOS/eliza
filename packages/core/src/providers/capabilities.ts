import { logger } from '../logger';
import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from '../types';

/**
 * Provider that collects capability descriptions from all registered services
 */
/**
 * Provides capabilities information for the agent.
 *
 * @param {IAgentRuntime} runtime - The agent runtime instance.
 * @param {Memory} _message - The memory message object.
 * @returns {Promise<ProviderResult>} The provider result object containing capabilities information.
 */
export const capabilitiesProvider: Provider = {
  name: 'CAPABILITIES',
  get: async (runtime: IAgentRuntime, _message: Memory): Promise<ProviderResult> => {
    try {
      // Get all registered services
      const services = runtime.getAllServices();

      if (!services || services.size === 0) {
        return {
          text: 'No services are currently registered.',
        };
      }

      // Extract capability descriptions from all services
      const capabilities: string[] = [];

      for (const [serviceType, service] of services) {
        if (service.capabilityDescription) {
          capabilities.push(
            `${serviceType} - ${service.capabilityDescription.replace('{{agentName}}', runtime.character.name)}`
          );
        }
      }

      if (capabilities.length === 0) {
        return {
          text: 'No capability descriptions found in the registered services.',
        };
      }

      // Format the capabilities into a readable list
      const formattedCapabilities = capabilities.join('\n');

      return {
        data: {
          capabilities,
        },
        text: `# ${runtime.character.name}'s Capabilities\n\n${formattedCapabilities}`,
      };
    } catch (error) {
      logger.error('Error in capabilities provider:', error);
      return {
        text: 'Error retrieving capabilities from services.',
      };
    }
  },
};

export default capabilitiesProvider;
