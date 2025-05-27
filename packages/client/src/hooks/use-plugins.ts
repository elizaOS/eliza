import { useQuery } from '@tanstack/react-query';

// Registry configuration - centralized for maintainability
const REGISTRY_ORG = 'elizaos-plugins';
const REGISTRY_REPO = 'registry';
const REGISTRY_URL = `https://raw.githubusercontent.com/${REGISTRY_ORG}/${REGISTRY_REPO}/refs/heads/main/index.json`;

/**
 * Function to fetch plugins data from the registry API.
 * @returns {Object} A promise representing the result of the fetch request
 */
export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: async () => {
      // TODO: Temp disabled!
      // const response = await fetch(REGISTRY_URL);
      // return response.json();

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
    },
  });
}
