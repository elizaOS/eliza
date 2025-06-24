import { ElizaClient, type ApiClientConfig } from '@elizaos/api-client';

export function createApiClientConfig(): ApiClientConfig {
  const getLocalStorageApiKey = () => `eliza-api-key-${window.location.origin}`;
  const apiKey = localStorage.getItem(getLocalStorageApiKey());

  return {
    baseUrl: window.location.origin,
    apiKey: apiKey || undefined,
    timeout: 30000,
    headers: {
      Accept: 'application/json',
    },
  };
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
