import { ElizaClient, type ApiClientConfig } from '@elizaos/api-client';
import { getEntityId } from './utils';

const getLocalStorageApiKey = () => `eliza-api-key-${window.location.origin}`;

export function createApiClientConfig(): ApiClientConfig {
  const apiKey = localStorage.getItem(getLocalStorageApiKey());
  const entityId = getEntityId();

  const config: ApiClientConfig = {
    baseUrl: window.location.origin,
    timeout: 30000,
    headers: {
      Accept: 'application/json',
      'X-Entity-Id': entityId,
    },
  };

  // Only include apiKey if it exists (don't pass undefined)
  if (apiKey) {
    config.apiKey = apiKey;
  }

  return config;
}

/**
 * Singleton pattern with explicit cache invalidation.
 *
 */
let elizaClientInstance: ElizaClient | null = null;

export function createElizaClient(): ElizaClient {
  return ElizaClient.create(createApiClientConfig());
}

export function getElizaClient(): ElizaClient {
  if (!elizaClientInstance) {
    elizaClientInstance = createElizaClient();
  }
  return elizaClientInstance;
}

/**
 * Invalidate the cached client instance.
 */
function invalidateElizaClient(): void {
  elizaClientInstance = null;
}

export function updateApiClientApiKey(newApiKey: string | null): void {
  if (newApiKey) {
    localStorage.setItem(getLocalStorageApiKey(), newApiKey);
  } else {
    localStorage.removeItem(getLocalStorageApiKey());
  }
  invalidateElizaClient();
}
