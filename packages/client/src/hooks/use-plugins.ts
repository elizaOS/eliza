import { useQuery } from '@tanstack/react-query';

/**
 * Function to fetch plugins data from the registry API.
 * @returns {Object} A promise representing the result of the fetch request
 */
export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: async () => {
      // TODO: Temp disabled!
      // const response = await fetch(
      //   'https://raw.githubusercontent.com/elizaos/registry/refs/heads/main/index.json'
      // );
      // return response.json();

      // Temporarily return hardcoded plugins as an array
      return [
        '@elizaos/plugin-sql',
        '@elizaos/plugin-local-ai',
        '@elizaos/plugin-anthropic',
        '@elizaos/plugin-openai',
        '@elizaos/plugin-discord',
        '@elizaos/plugin-pdf',
        '@elizaos/plugin-video-understanding',
      ];
    },
  });
}
