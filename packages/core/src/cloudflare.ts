import { IAgentRuntime } from './types';
import { elizaLogger } from './logger';

/**
 * Returns the Cloudflare Gateway base URL for a given model provider if the gateway is enabled and properly configured.
 *
 * If Cloudflare Gateway is not enabled or required configuration values are missing, returns `undefined`.
 *
 * @param provider - The name of the model provider.
 * @returns The Cloudflare Gateway base URL for the provider, or `undefined` if the gateway is not enabled or not configured.
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
 * Returns the base URL for a model provider, preferring the Cloudflare Gateway if enabled and properly configured.
 *
 * If the Cloudflare Gateway is not enabled or required configuration is missing, returns the provided default base URL.
 *
 * @param provider - The name of the model provider.
 * @param defaultBaseURL - The fallback base URL if Cloudflare Gateway is unavailable.
 * @returns The base URL to use for the provider.
 */
export function getProviderBaseURL(
  runtime: IAgentRuntime,
  provider: string,
  defaultBaseURL: string
): string {
  return getCloudflareGatewayBaseURL(runtime, provider) ?? defaultBaseURL;
}
