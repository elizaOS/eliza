import { ElizaClient, type ApiClientConfig } from '@elizaos/api-client';

export function createApiClientConfig(): ApiClientConfig {
  const getLocalStorageApiKey = () => `eliza-api-key-${window.location.origin}`;
  const apiKey = localStorage.getItem(getLocalStorageApiKey());

  const config: ApiClientConfig = {
    baseUrl: window.location.origin,
    timeout: 30000,
    headers: {
      Accept: 'application/json',
    },
  };

  // Only include apiKey if it exists (don't pass undefined)
  if (apiKey) {
    config.apiKey = apiKey;
  }

  return config;
}

export function createElizaClient(): ElizaClient {
  return ElizaClient.create(createApiClientConfig());
}

export function updateApiClientApiKey(newApiKey: string | null): void {
  const getLocalStorageApiKey = () => `eliza-api-key-${window.location.origin}`;

  if (newApiKey) {
    localStorage.setItem(getLocalStorageApiKey(), newApiKey);
  } else {
    localStorage.removeItem(getLocalStorageApiKey());
  }
}
