import type { OptionValues } from 'commander';
import type { ApiClientConfig } from '@elizaos/api-client';
import { getAgentRuntimeUrl } from './url-utils';
import { loadEnvFilesWithPrecedence } from '@elizaos/core';

/**
 * Load .env files to ensure environment variables (like ELIZA_SERVER_AUTH_TOKEN)
 * are available for CLI commands. This ensures consistency with the start command.
 */
function loadEnvVars() {
  try {
    const cwd = process.cwd();
    loadEnvFilesWithPrecedence(cwd);
  } catch (error) {
    // Silently fail if .env loading fails - environment variables may still be set
  }
}

/**
 * Get authentication headers for API requests
 * @param opts - Command options that may contain auth information
 * @returns Headers object with authentication if token is available
 */
export function getAuthHeaders(opts: OptionValues): Record<string, string> {
  // Load .env files to ensure environment variables are available
  loadEnvVars();

  // Check for auth token in command options first, then environment variables
  const authToken = opts.authToken || process.env.ELIZA_SERVER_AUTH_TOKEN;

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
  // Load .env files to ensure environment variables are available
  loadEnvVars();

  const authToken = opts.authToken || process.env.ELIZA_SERVER_AUTH_TOKEN;

  return {
    baseUrl: getAgentRuntimeUrl(opts),
    apiKey: authToken,
    timeout: 30000, // 30 seconds default
    headers: {
      'Content-Type': 'application/json',
    },
  };
}
