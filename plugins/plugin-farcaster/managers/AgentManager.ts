/**
 * Owns one Farcaster account for an agent: builds the Neynar SDK client from the
 * account's config and wires up the autonomous cast loop and interaction manager.
 * `FarcasterService` holds one instance per (agent, account); `start`/`stop`
 * fan out to both child managers.
 */
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
  readonly config: FarcasterConfig & { accountId?: string };

  constructor(runtime: IAgentRuntime, config: FarcasterConfig & { accountId?: string }) {
    this.runtime = runtime;
    this.config = config;
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
