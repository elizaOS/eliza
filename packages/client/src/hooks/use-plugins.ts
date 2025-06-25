import { useQuery } from '@tanstack/react-query';
import { createElizaClient } from '@/lib/api-client-config';
import clientLogger from '@/lib/logger';

// Registry configuration - centralized for maintainability
const REGISTRY_ORG = 'elizaos-plugins';
const REGISTRY_REPO = 'registry';
const REGISTRY_URL = `https://raw.githubusercontent.com/${REGISTRY_ORG}/${REGISTRY_REPO}/refs/heads/main/generated-registry.json`;

interface GitVersionInfo {
  version: string | null;
  branch: string | null;
}

interface PluginGitInfo {
  repo: string;
  v0: GitVersionInfo;
  v1: GitVersionInfo;
}

interface PluginNpmInfo {
  repo: string;
  v0: string | null;
  v1: string | null;
}

interface PluginSupport {
  v0: boolean;
  v1: boolean;
}

interface PluginInfo {
  git: PluginGitInfo;
  npm: PluginNpmInfo;
  supports: PluginSupport;
}

interface RegistryResponse {
  lastUpdatedAt: string;
  registry: Record<string, PluginInfo>;
}

/**
 * Function to fetch plugins data from the registry API and merge with agent plugins.
 * @returns {UseQueryResult<PluginEntry[]>} Query result containing array of plugin entries
 */
export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: async () => {
      try {
        // Fetch plugins from registry and agent data in parallel
        const elizaClient = createElizaClient();
        const [registryResponse, agentsResponse] = await Promise.all([
          fetch(REGISTRY_URL),
          elizaClient.agents.listAgents(),
        ]);

        // Process registry data
        const registryData: RegistryResponse = await registryResponse.json();

        // Extract plugin names from registry that support v1 and are plugins
        const registryPlugins = Object.entries(registryData.registry || {})
          .filter(([name, data]: [string, PluginInfo]) => {
            // Check if it's a plugin and has v1 support
            const isPlugin = name.includes('plugin');
            const hasV1Support = data.supports.v1 === true;
            const hasV1Version =
              data.npm.v1 !== null || (data.git.v1.version !== null && data.git.v1.branch !== null);

            return isPlugin && hasV1Support && hasV1Version;
          })
          .map(([name]) => name.replace(/^@elizaos-plugins\//, '@elizaos/'))
          .sort();

        // Process agent plugins from the parallel fetch
        let agentPlugins: string[] = [];
        try {
          if (agentsResponse?.length > 0) {
            // Get plugins from the first active agent
            const activeAgent = agentsResponse.find((agent) => agent.status === 'active');
            if (activeAgent && activeAgent.id) {
              const agentDetailResponse = await elizaClient.agents.getAgent(activeAgent.id);

              if (agentDetailResponse?.plugins) {
                agentPlugins = agentDetailResponse.plugins;
              }
            }
          }
        } catch (agentError) {
          clientLogger.warn('Could not fetch agent plugins:', agentError);
        }

        // Merge registry plugins with agent plugins and remove duplicates
        const allPlugins = [...new Set([...registryPlugins, ...agentPlugins])];
        return allPlugins.sort();
      } catch (error) {
        clientLogger.error('Failed to fetch from registry, falling back to basic list:', error);

        // Return fallback plugins with basic info
        return [
          '@elizaos/plugin-bootstrap',
          '@elizaos/plugin-evm',
          '@elizaos/plugin-discord',
          '@elizaos/plugin-elevenlabs',
          '@elizaos/plugin-anthropic',
          '@elizaos/plugin-browser',
          '@elizaos/plugin-farcaster',
          '@elizaos/plugin-groq',
        ]
          .filter((name) => name.includes('plugin'))
          .sort();
      }
    },
  });
}
