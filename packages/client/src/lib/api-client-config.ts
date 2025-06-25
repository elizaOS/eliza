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

// Singleton instance
let elizaClientInstance: ElizaClient | null = null;

export function createElizaClient(): ElizaClient {
  if (!elizaClientInstance) {
    elizaClientInstance = ElizaClient.create(createApiClientConfig());
  }
  return elizaClientInstance;
}

export function getElizaClient(): ElizaClient {
  return createElizaClient();
}

// Function to reset the singleton (useful for API key changes)
export function resetElizaClient(): void {
  elizaClientInstance = null;
}

export function updateApiClientApiKey(newApiKey: string | null): void {
  const getLocalStorageApiKey = () => `eliza-api-key-${window.location.origin}`;

  if (newApiKey) {
    localStorage.setItem(getLocalStorageApiKey(), newApiKey);
  } else {
    localStorage.removeItem(getLocalStorageApiKey());
  }

  // Reset the singleton so it uses the new API key
  resetElizaClient();
}
