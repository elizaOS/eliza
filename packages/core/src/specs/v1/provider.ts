import { IAgentRuntime, Memory, State, Provider as ProviderFromTypes } from './types';
import { toV2State } from './state';
import { Provider as ProviderV2, ProviderResult } from '../v2';

/**
 * Provider for external data/services
 * This is a v1 compatibility wrapper for v2 Provider
 */
export type Provider = ProviderFromTypes;

/**
 * Converts v2 Provider to v1 compatible Provider
 * Uses the V2 Provider interface to ensure proper optional field handling
 */
export function fromV2Provider(providerV2: ProviderV2): Provider {
  return {
    name: providerV2.name,
    description: providerV2.description,
    dynamic: providerV2.dynamic,
    position: providerV2.position,
    private: providerV2.private,
    get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
      // Convert v1 state to v2 state if provided
      const stateV2 = state ? toV2State(state) : undefined;

      try {
        // Call the v2 provider with transformed parameters
        const result = await providerV2.get(runtime as any, message as any, stateV2 as any);

        // Extract text or use an empty string if not present
        return result.text || '';
      } catch (error) {
        console.error(`Error in v2 provider ${providerV2.name}:`, error);
        throw error;
      }
    },
  };
}

/**
 * Converts v1 Provider to v2 Provider
 * Creates a Provider object conforming to V2 Provider interface
 */
export function toV2Provider(provider: Provider): ProviderV2 {
  return {
    name: provider.name || 'unnamed-provider',
    description: provider.description,
    dynamic: provider.dynamic,
    position: provider.position,
    private: provider.private,
    get: async (runtime: any, message: any, state: any): Promise<ProviderResult> => {
      try {
        // Call the v1 provider directly
        const result = await provider.get(runtime, message, state);

        // Format according to V2 ProviderResult
        if (typeof result === 'object' && result !== null) {
          // For objects, preserve all properties for full compatibility
          return {
            ...result,
            values: result.values || {},
            data: result.data || {},
            text: result.text || '',
          };
        }

        // For primitive results, return as text
        return {
          values: {},
          data: {},
          text: String(result || ''),
        };
      } catch (error) {
        console.error(`Error in v1 provider ${provider.name || 'unnamed'}:`, error);
        throw error;
      }
    },
  };
}
