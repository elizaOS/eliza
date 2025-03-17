import { addHeader } from '../prompts';
import type { IAgentRuntime, Memory, Provider } from '../types';

/**
 * Provider for retrieving list of all data providers available for the agent to use.
 * @type { Provider }
 */
export const providersProvider: Provider = {
  name: 'PROVIDERS',
  description: 'List of all data providers the agent can use to get additional information',
  get: async (runtime: IAgentRuntime, _message: Memory) => {
    // Filter providers with dynamic: true
    const dynamicProviders = runtime.providers.filter((provider) => provider.dynamic === true);

    // Create formatted text for each provider
    const providerDescriptions = dynamicProviders.map((provider) => {
      return `- **${provider.name}**: ${provider.description || 'No description available'}`;
    });

    // Create the header text
    const headerText =
      '# Providers\n\nThese providers are available for the agent to select and use:';

    // If no dynamic providers are found
    if (providerDescriptions.length === 0) {
      return {
        text: addHeader(headerText, 'No dynamic providers are currently available.'),
      };
    }

    // Join all provider descriptions
    const providersText = providerDescriptions.join('\n');

    // Combine header and provider descriptions
    const text = addHeader(headerText, providersText);

    // Also provide the data for potential programmatic use
    const data = {
      dynamicProviders: dynamicProviders.map((provider) => ({
        name: provider.name,
        description: provider.description || '',
      })),
    };

    return {
      text,
      data,
    };
  },
};
