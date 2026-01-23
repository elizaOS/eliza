import type { OptionValues } from 'commander';
import type { ApiClientConfig } from '@elizaos/api-client';
import { getAgentRuntimeUrl } from './url-utils';

/**
 * Get authentication headers for API requests
 * @param opts - Command options that may contain auth information
 * @returns Headers object with authentication if token is available
 */
export function getAuthHeaders(opts: OptionValues): Record<string, string> {
  // Check for auth token in command options first, then environment variables
  const authToken = opts.authToken || process.env.ELIZAOS_API_KEY;

  // If we have an auth token, include it in the headers
  if (authToken) {
    return {
      'X-API-KEY': authToken,
    };
  }

  // No auth required
  return {};
}

/**
 * Create ApiClientConfig from CLI options
 * @param opts - Command options that may contain auth and connection information
 * @returns ApiClientConfig for use with @elizaos/api-client
 */
export function createApiClientConfig(opts: OptionValues): ApiClientConfig {
  const authToken = opts.authToken || process.env.ELIZAOS_API_KEY;

  return {
    baseUrl: getAgentRuntimeUrl(opts),
    apiKey: authToken,
    timeout: 30000, // 30 seconds default
    headers: {
      'Content-Type': 'application/json',
    },
  };
}
