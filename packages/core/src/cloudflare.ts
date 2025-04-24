import { IAgentRuntime } from './types';
import { elizaLogger } from './logger';

/**
 * Gets the Cloudflare Gateway base URL for a specific provider if enabled
 * @param runtime The runtime environment
 * @param provider The model provider name
 * @returns The Cloudflare Gateway base URL if enabled, undefined otherwise
 */
export function getCloudflareGatewayBaseURL(
  runtime: IAgentRuntime,
  provider: string
): string | undefined {
  const isCloudflareEnabled = runtime.getSetting('CLOUDFLARE_GW_ENABLED') === 'true';
  const cloudflareAccountId = runtime.getSetting('CLOUDFLARE_AI_ACCOUNT_ID');
  const cloudflareGatewayId = runtime.getSetting('CLOUDFLARE_AI_GATEWAY_ID');

  elizaLogger.debug('Cloudflare Gateway Configuration:', {
    isEnabled: isCloudflareEnabled,
    hasAccountId: !!cloudflareAccountId,
    hasGatewayId: !!cloudflareGatewayId,
    provider: provider,
  });

  if (!isCloudflareEnabled) {
    elizaLogger.debug('Cloudflare Gateway is not enabled');
    return undefined;
  }

  if (!cloudflareAccountId) {
    elizaLogger.warn('Cloudflare Gateway is enabled but CLOUDFLARE_AI_ACCOUNT_ID is not set');
    return undefined;
  }

  if (!cloudflareGatewayId) {
    elizaLogger.warn('Cloudflare Gateway is enabled but CLOUDFLARE_AI_GATEWAY_ID is not set');
    return undefined;
  }

  const baseURL = `https://gateway.ai.cloudflare.com/v1/${cloudflareAccountId}/${cloudflareGatewayId}/${provider.toLowerCase()}`;
  elizaLogger.info('Using Cloudflare Gateway:', {
    provider,
    baseURL,
    accountId: cloudflareAccountId,
    gatewayId: cloudflareGatewayId,
  });
  return baseURL;
}

/**
 * Gets the correct base URL for a provider, using Cloudflare Gateway if enabled, otherwise falling back to the default.
 * @param runtime The runtime environment
 * @param provider The model provider name
 * @param defaultBaseURL The default base URL for the provider
 * @returns The base URL to use
 */
export function getProviderBaseURL(
  runtime: IAgentRuntime,
  provider: string,
  defaultBaseURL: string
): string {
  return getCloudflareGatewayBaseURL(runtime, provider) ?? defaultBaseURL;
}
