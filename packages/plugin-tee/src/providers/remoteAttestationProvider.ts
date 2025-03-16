import { promises as fs } from 'node:fs'; // Fix: Use node: protocol
import { type IAgentRuntime, type Memory, type Provider, type State, logger } from '@elizaos/core';
import { type RemoteAttestationMessage, type RemoteAttestationQuote, TEEMode } from '@elizaos/core';
import type { SgxAttestation } from '@elizaos/core';
import { TappdClient, type TdxQuoteHashAlgorithms, type TdxQuoteResponse } from '@phala/dstack-sdk';
import { calculateSHA256 } from '../utils';
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

/**
 * SGX Gramine TEE Provider
 * @example
 * ```ts
 * const provider = new SgxAttestationProvider();
 * ```
 */
class SgxAttestationProvider extends RemoteAttestationProvider {
  private readonly SGX_QUOTE_MAX_SIZE: number = 8192 * 4;
  private readonly SGX_TARGET_INFO_SIZE: number = 512;

  private readonly MY_TARGET_INFO_PATH: string = '/dev/attestation/my_target_info';
  private readonly TARGET_INFO_PATH: string = '/dev/attestation/target_info';
  private readonly USER_REPORT_DATA_PATH: string = '/dev/attestation/user_report_data';
  private readonly QUOTE_PATH: string = '/dev/attestation/quote';

  // Remove unnecessary constructor
  // constructor() {}

  async generateAttestation(reportData: string): Promise<SgxAttestation> {
    // Hash the report data to generate the raw user report.
    // The resulting hash value is 32 bytes long.
    // Ensure that the length of the raw user report does not exceed 64 bytes.
    const rawUserReport = calculateSHA256(reportData);

    try {
      // Check if the gramine attestation device file exists
      await fs.access(this.MY_TARGET_INFO_PATH);

      const quote = await this.generateQuoteByGramine(rawUserReport);
      const attestation: SgxAttestation = {
        quote: quote,
        timestamp: Date.now(),
      };
      // console.log("SGX remote attestation: ", attestation);
      return attestation;
    } catch (error) {
      console.error('Error generating SGX remote attestation:', error);
      throw new Error(
        `Failed to generate SGX Quote: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async generateQuoteByGramine(rawUserReport: Buffer): Promise<string> {
    if (rawUserReport.length > 64) {
      throw new Error('the length of rawUserReport exceeds 64 bytes');
    }

    const myTargetInfo = await fs.readFile(this.MY_TARGET_INFO_PATH);
    if (myTargetInfo.length !== this.SGX_TARGET_INFO_SIZE) {
      throw new Error('Invalid my_target_info length');
    }

    await fs.writeFile(this.TARGET_INFO_PATH, myTargetInfo);
    await fs.writeFile(this.USER_REPORT_DATA_PATH, rawUserReport);

    // Read quote
    const quoteData = await fs.readFile(this.QUOTE_PATH);
    if (quoteData.length > this.SGX_QUOTE_MAX_SIZE) {
      throw new Error('Invalid quote length');
    }

    const realLen = quoteData.lastIndexOf(0);
    if (realLen === -1) {
      throw new Error('quote without EOF');
    }

    //return '0x' + quoteData.subarray(0, realLen + 1).toString('hex');
    return `0x${quoteData.subarray(0, realLen + 1).toString('hex')}`; // Fix: Use template literal
  }
}

const sgxAttestationProvider: Provider = {
  name: 'sgx-gramine-remote-attestation',
  get: async (runtime: IAgentRuntime, _message: Memory): Promise<ProviderResult> => {
    const provider = new SgxAttestationProvider();
    const agentId = runtime.agentId;

    try {
      // console.log("Generating attestation for agent: ", agentId);
      const attestation = await provider.generateAttestation(agentId);

      return {
        data: attestation,
        values: {
          quote: attestation.quote,
          timestamp: attestation.timestamp.toString(),
        },
        text: `Your Agent's remote attestation is: ${JSON.stringify(attestation)}`,
      };
    } catch (error) {
      console.error('Error in remote attestation provider:', error);
      const errorMessage = `Failed to generate SGX Quote: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`;

      return {
        data: null,
        values: {},
        text: errorMessage,
      };
    }
  },
};

export {
  phalaRemoteAttestationProvider,
  PhalaRemoteAttestationProvider,
  sgxAttestationProvider,
  SgxAttestationProvider,
};
