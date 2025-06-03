import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import clientLogger from '@/lib/logger';

// Registry configuration - centralized for maintainability
const REGISTRY_ORG = 'elizaos-plugins';
const REGISTRY_REPO = 'registry';
const REGISTRY_URL = `https://raw.githubusercontent.com/${REGISTRY_ORG}/${REGISTRY_REPO}/refs/heads/main/generated-registry.json`;

/**
 * Function to fetch plugins data from the registry API and merge with agent plugins.
 * @returns {Object} A promise representing the result of the fetch request
 */
export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: async () => {
      try {
        // Fetch plugins from registry and agent data in parallel
        const [registryResponse, agentsResponse] = await Promise.all([
          fetch(REGISTRY_URL),
          apiClient.getAgents(),
        ]);

        // Process registry data
        const registryData = await registryResponse.json();

        // Extract plugin names from registry that support v1 and are plugins
        const registryPlugins = Object.entries(registryData.registry || {})
          .filter(
            ([name, data]: [string, any]) => name.includes('plugin') && data.supports?.v1 === true
          )
          .map(([name]) => name)
          .sort();

        // Process agent plugins from the parallel fetch
        let agentPlugins: string[] = [];
        try {
          if (agentsResponse.data?.agents?.length > 0) {
            // Get plugins from the first active agent
            const activeAgent = agentsResponse.data.agents.find(
              (agent) => agent.status === 'active'
            );
            if (activeAgent && activeAgent.id) {
              const agentDetailResponse = await apiClient.getAgent(activeAgent.id);
              if (agentDetailResponse.data?.plugins) {
                agentPlugins = agentDetailResponse.data.plugins;
              }
            }
          }
        } catch (agentError) {
          clientLogger.warn('Could not fetch agent plugins:', agentError);
        }

        // Merge registry plugins with agent plugins, removing duplicates
        const allPlugins = [...new Set([...registryPlugins, ...agentPlugins])];

        return allPlugins.sort();
      } catch (error) {
        clientLogger.error('Failed to fetch from registry, falling back to basic list:', error);

        // Temporarily return hardcoded plugins as an array
        return [
          '@elizaos/core',
          '@elizaos/plugin-bootstrap',
          '@elizaos/plugin-evm',
          '@elizaos/plugin-solana',
          '@elizaos/plugin-tee',
          '@elizaos/plugin-twitter',
          '@elizaos/plugin-openai',
          '@elizaos/plugin-telegram',
          '@elizaos/cli',
          '@elizaos/plugin-discord',
          '@elizaos/plugin-elevenlabs',
          '@elizaos/plugin-anthropic',
          '@elizaos/plugin-local-ai',
          '@elizaos/plugin-sql',
          '@elizaos/plugin-browser',
          '@elizaos/plugin-video-understanding',
          '@elizaos/plugin-pdf',
          '@elizaos/plugin-storage-s3',
          '@elizaos/plugin-farcaster',
          '@elizaos/plugin-groq',
          '@elizaos/plugin-redpill',
          '@elizaos/plugin-ollama',
          '@elizaos/plugin-venice',
          '@fleek-platform/eliza-plugin-mcp',
        ]
          .filter((name) => name.includes('plugin'))
          .sort();
      }
    },
  });
}
