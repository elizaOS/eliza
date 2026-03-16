import { type IAgentRuntime, logger, type Memory, type Provider } from "@elizaos/core";
import { TappdClient, type TdxQuoteHashAlgorithms, type TdxQuoteResponse } from "@phala/dstack-sdk";
import type {
  RemoteAttestationMessage,
  RemoteAttestationQuote,
  TdxQuoteHashAlgorithm,
  TeeProviderResult,
} from "../types";
import { getTeeEndpoint } from "../utils";
import { RemoteAttestationProvider } from "./base";

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

  async generateAttestation(
    reportData: string,
    hashAlgorithm?: TdxQuoteHashAlgorithm
  ): Promise<RemoteAttestationQuote> {
    try {
      const tdxQuote: TdxQuoteResponse = await this.client.tdxQuote(
        reportData,
        hashAlgorithm as TdxQuoteHashAlgorithms | undefined
      );

      return {
        quote: tdxQuote.quote,
        timestamp: Date.now(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error generating remote attestation: ${message}`);
      throw new Error(`Failed to generate TDX Quote: ${message}`);
    }
  }
}

export const phalaRemoteAttestationProvider: Provider = {
  name: "phala-remote-attestation",

  get: async (runtime: IAgentRuntime, message: Memory): Promise<TeeProviderResult> => {
    const teeModeRaw = runtime.getSetting("TEE_MODE");
    if (!teeModeRaw) {
      return {
        data: null,
        values: {},
        text: "TEE_MODE is not configured",
      };
    }
    const teeMode = typeof teeModeRaw === "string" ? teeModeRaw : String(teeModeRaw);

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

      const attestation = await provider.generateAttestation(JSON.stringify(attestationMessage));

      return {
        data: {
          quote: attestation.quote,
          timestamp: attestation.timestamp.toString(),
        },
        values: {
          quote: attestation.quote,
          timestamp: attestation.timestamp.toString(),
        },
        text: `Remote attestation: ${attestation.quote.substring(0, 64)}...`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error in remote attestation provider: ${message}`);
      throw new Error(`Failed to generate TDX Quote: ${message}`);
    }
  },
};
