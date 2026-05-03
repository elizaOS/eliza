import type { IAgentRuntime } from "@elizaos/core";
import { Configuration, NeynarAPIClient } from "@neynar/nodejs-sdk";
import { FarcasterClient } from "../client/FarcasterClient";
import type { FarcasterConfig } from "../types";
import { FarcasterCastManager } from "./CastManager";
import { FarcasterInteractionManager } from "./InteractionManager";

export class FarcasterAgentManager {
  readonly runtime: IAgentRuntime;
  readonly client: FarcasterClient;
  readonly casts: FarcasterCastManager;
  readonly interactions: FarcasterInteractionManager;

  constructor(runtime: IAgentRuntime, config: FarcasterConfig) {
    this.runtime = runtime;
    const signerUuid = config.FARCASTER_SIGNER_UUID;

    const neynarConfig = new Configuration({
      apiKey: config.FARCASTER_NEYNAR_API_KEY,
    });
    const neynar = new NeynarAPIClient(neynarConfig);
    const client = new FarcasterClient({ neynar, signerUuid });

    this.client = client;

    runtime.logger.success("Farcaster Neynar client initialized.");

    this.interactions = new FarcasterInteractionManager({
      client,
      runtime,
      config,
    });
    this.casts = new FarcasterCastManager({ client, runtime, config });
  }

  async start(): Promise<void> {
    await Promise.all([this.casts.start(), this.interactions.start()]);
  }

  async stop(): Promise<void> {
    await Promise.all([this.casts.stop(), this.interactions.stop()]);
  }
}
