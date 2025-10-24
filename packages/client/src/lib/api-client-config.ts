import { ElizaClient, type ApiClientConfig } from '@elizaos/api-client';

let elizaClientInstance: ElizaClient | null = null;

const getLocalStorageApiKey = () => `eliza-api-key-${window.location.origin}`;

export function createApiClientConfig(): ApiClientConfig {
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

export function updateApiClientApiKey(newApiKey: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }

  const storageKey = getLocalStorageApiKey();

  if (newApiKey === null || newApiKey === '') {
    localStorage.removeItem(storageKey);
  } else {
    localStorage.setItem(storageKey, newApiKey);
  }

  // Reset the client instance so it gets recreated with the new API key
  resetElizaClient();
}
