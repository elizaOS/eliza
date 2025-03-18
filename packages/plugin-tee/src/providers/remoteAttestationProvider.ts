import { type IAgentRuntime, type Memory, type Provider, logger } from '@elizaos/core';
import { type RemoteAttestationMessage, type RemoteAttestationQuote, TEEMode } from '@elizaos/core';
import { TappdClient, type TdxQuoteHashAlgorithms, type TdxQuoteResponse } from '@phala/dstack-sdk';
import { RemoteAttestationProvider } from './base';

// Define the ProviderResult interface if not already imported
/**
 * Interface for the result returned by a provider.
 * @typedef {Object} ProviderResult
 * @property {any} data - The data returned by the provider.
 * @property {Record<string, string>} values - The values returned by the provider.
 * @property {string} text - The text returned by the provider.
 */
interface ProviderResult {
  data?: any;
  values?: Record<string, string>;
  text?: string;
}

/**
 * Phala TEE Cloud Provider
 * @example
 * ```ts
 * const provider = new PhalaRemoteAttestationProvider();
 * ```
 */
/**
 * PhalaRemoteAttestationProvider class that extends RemoteAttestationProvider
 * @extends RemoteAttestationProvider
 */
class PhalaRemoteAttestationProvider extends RemoteAttestationProvider {
  private client: TappdClient;

  constructor(teeMode?: string) {
    super();
    let endpoint: string | undefined;

    // Both LOCAL and DOCKER modes use the simulator, just with different endpoints
    switch (teeMode) {
      case TEEMode.LOCAL:
        endpoint = 'http://localhost:8090';
        logger.log('TEE: Connecting to local simulator at localhost:8090');
        break;
      case TEEMode.DOCKER:
        endpoint = 'http://host.docker.internal:8090';
        logger.log('TEE: Connecting to simulator via Docker at host.docker.internal:8090');
        break;
      case TEEMode.PRODUCTION:
        endpoint = undefined;
        logger.log('TEE: Running in production mode without simulator');
        break;
      default:
        throw new Error(`Invalid TEE_MODE: ${teeMode}. Must be one of: LOCAL, DOCKER, PRODUCTION`);
    }

    this.client = endpoint ? new TappdClient(endpoint) : new TappdClient();
  }

  async generateAttestation(
    reportData: string,
    hashAlgorithm?: TdxQuoteHashAlgorithms
  ): Promise<RemoteAttestationQuote> {
    try {
      logger.log('Generating attestation for: ', reportData);
      const tdxQuote: TdxQuoteResponse = await this.client.tdxQuote(reportData, hashAlgorithm);
      const rtmrs = tdxQuote.replayRtmrs();
      logger.log(`rtmr0: ${rtmrs[0]}\nrtmr1: ${rtmrs[1]}\nrtmr2: ${rtmrs[2]}\nrtmr3: ${rtmrs[3]}f`);
      const quote: RemoteAttestationQuote = {
        quote: tdxQuote.quote,
        timestamp: Date.now(),
      };
      logger.log('Remote attestation quote: ', quote);
      return quote;
    } catch (error) {
      console.error('Error generating remote attestation:', error);
      throw new Error(
        `Failed to generate TDX Quote: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}

// Keep the original provider for backwards compatibility
const phalaRemoteAttestationProvider: Provider = {
  name: 'phala-remote-attestation',
  get: async (runtime: IAgentRuntime, message: Memory) => {
    const teeMode = runtime.getSetting('TEE_MODE');
    const provider = new PhalaRemoteAttestationProvider(teeMode);
    const agentId = runtime.agentId;

    try {
      const attestationMessage: RemoteAttestationMessage = {
        agentId: agentId,
        timestamp: Date.now(),
        message: {
          entityId: message.entityId,
          roomId: message.roomId,
          content: message.content.text,
        },
      };
      logger.log('Generating attestation for: ', JSON.stringify(attestationMessage));
      const attestation = await provider.generateAttestation(JSON.stringify(attestationMessage));
      return {
        text: `Your Agent's remote attestation is: ${JSON.stringify(attestation)}`,
        data: {
          attestation,
        },
        values: {
          quote: attestation.quote,
          timestamp: attestation.timestamp.toString(),
        },
      };
    } catch (error) {
      console.error('Error in remote attestation provider:', error);
      throw new Error(
        `Failed to generate TDX Quote: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  },
};

export { phalaRemoteAttestationProvider, PhalaRemoteAttestationProvider };
