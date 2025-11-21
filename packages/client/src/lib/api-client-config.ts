import { ElizaClient, type ApiClientConfig } from '@elizaos/api-client';

const getLocalStorageApiKey = () => `eliza-api-key-${window.location.origin}`;
const getLocalStorageJwtKey = () => `eliza-jwt-token-${window.location.origin}`;

export function createApiClientConfig(): ApiClientConfig {
  const apiKey = localStorage.getItem(getLocalStorageApiKey());
  const jwtToken = localStorage.getItem(getLocalStorageJwtKey());

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

  // Add JWT token to Authorization header if it exists
  if (jwtToken) {
    config.headers = {
      ...config.headers,
      Authorization: `Bearer ${jwtToken}`,
    };
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

export function updateApiClientJwtToken(newJwtToken: string | null): void {
  if (newJwtToken) {
    localStorage.setItem(getLocalStorageJwtKey(), newJwtToken);
  } else {
    localStorage.removeItem(getLocalStorageJwtKey());
  }
  invalidateElizaClient();
}
