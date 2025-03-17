import { useQuery } from '@tanstack/react-query';

/**
 * Function to fetch plugins data from the registry API.
 * @returns {Object} A promise representing the result of the fetch request
 */
export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: async () => {
      const response = await fetch(
        'https://raw.githubusercontent.com/elizaos/registry/refs/heads/main/index.json'
      );
      return response.json();
    },
  });
}
