/**
 * Remote Attestation Provider for Phala TEE.
 */

import { type Provider, type IAgentRuntime, type Memory, logger } from "@elizaos/core";
import { TappdClient, type TdxQuoteHashAlgorithms, type TdxQuoteResponse } from "@phala/dstack-sdk";
import type { RemoteAttestationQuote, RemoteAttestationMessage, TdxQuoteHashAlgorithm, TeeProviderResult } from "../types";
import { getTeeEndpoint } from "../utils";
import { RemoteAttestationProvider } from "./base";

/**
 * Phala Network Remote Attestation Provider.
 *
 * Generates TDX attestation quotes for proving TEE execution.
 */
export class PhalaRemoteAttestationProvider extends RemoteAttestationProvider {
  private readonly client: TappdClient;

  constructor(teeMode: string) {
    super();
    const endpoint = getTeeEndpoint(teeMode);

    logger.info(
      endpoint
        ? `TEE: Connecting to simulator at ${endpoint}`
        : "TEE: Running in production mode without simulator"
    );

    this.client = endpoint ? new TappdClient(endpoint) : new TappdClient();
  }

  /**
   * Generate a remote attestation quote.
   *
   * @param reportData - The data to include in the attestation report.
   * @param hashAlgorithm - Optional hash algorithm for the quote.
   * @returns The remote attestation quote.
   */
  async generateAttestation(
    reportData: string,
    hashAlgorithm?: TdxQuoteHashAlgorithm
  ): Promise<RemoteAttestationQuote> {
    try {
      logger.debug(`Generating attestation for: ${reportData.substring(0, 100)}...`);

      const tdxQuote: TdxQuoteResponse = await this.client.tdxQuote(
        reportData,
        hashAlgorithm as TdxQuoteHashAlgorithms | undefined
      );

      const rtmrs = tdxQuote.replayRtmrs();
      logger.debug(
        `RTMR values: rtmr0=${rtmrs[0]}, rtmr1=${rtmrs[1]}, rtmr2=${rtmrs[2]}, rtmr3=${rtmrs[3]}`
      );

      const quote: RemoteAttestationQuote = {
        quote: tdxQuote.quote,
        timestamp: Date.now(),
      };

      logger.info("Remote attestation quote generated successfully");
      return quote;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error generating remote attestation: ${message}`);
      throw new Error(`Failed to generate TDX Quote: ${message}`);
    }
  }
}

/**
 * elizaOS Provider for remote attestation.
 *
 * This provider generates attestation based on the current message context.
 */
export const phalaRemoteAttestationProvider: Provider = {
  name: "phala-remote-attestation",

  get: async (runtime: IAgentRuntime, message: Memory): Promise<TeeProviderResult> => {
    const teeMode = runtime.getSetting("TEE_MODE");
    if (!teeMode) {
      return {
        data: null,
        values: {},
        text: "TEE_MODE is not configured",
      };
    }

    const provider = new PhalaRemoteAttestationProvider(teeMode);
    const agentId = runtime.agentId;

    try {
      const attestationMessage: RemoteAttestationMessage = {
        agentId,
        timestamp: Date.now(),
        message: {
          entityId: message.entityId,
          roomId: message.roomId,
          content: message.content.text ?? "",
        },
      };

      logger.debug(`Generating attestation for message: ${JSON.stringify(attestationMessage)}`);

      const attestation = await provider.generateAttestation(
        JSON.stringify(attestationMessage)
      );

      return {
        data: {
          quote: attestation.quote,
          timestamp: attestation.timestamp.toString(),
        },
        values: {
          quote: attestation.quote,
          timestamp: attestation.timestamp.toString(),
        },
        text: `Your Agent's remote attestation is: ${JSON.stringify(attestation)}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error in remote attestation provider: ${message}`);
      throw new Error(`Failed to generate TDX Quote: ${message}`);
    }
  },
};


