import { ElizaClient, type ApiClientConfig } from '@elizaos/api-client';

let elizaClientInstance: ElizaClient | null = null;

export function createApiClientConfig(): ApiClientConfig {
  const getLocalStorageApiKey = () => `eliza-api-key-${window.location.origin}`;
  const apiKey = typeof window !== 'undefined' ? localStorage.getItem(getLocalStorageApiKey()) : null;

  const config: ApiClientConfig = {
    baseUrl: typeof window !== 'undefined' ? window.location.origin : '',
    timeout: 30000,
    headers: {
      Accept: 'application/json',
    },
  };

  if (apiKey) {
    config.apiKey = apiKey;
  }

  return config;
}

export function createElizaClient(): ElizaClient {
  if (!elizaClientInstance) {
    elizaClientInstance = new ElizaClient(createApiClientConfig());
  }
  return elizaClientInstance;
}

export function resetElizaClient(): void {
  elizaClientInstance = null;
}
