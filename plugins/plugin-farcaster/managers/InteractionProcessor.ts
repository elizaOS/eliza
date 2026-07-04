/**
 * Contract an interaction source calls into to process inbound casts. Decouples
 * the source (polling vs webhook) from the concrete `FarcasterInteractionManager`
 * that implements mention/reply/webhook handling and memory creation.
 */
import type { Memory } from "@elizaos/core";
import type { Cast as NeynarCast } from "@neynar/nodejs-sdk/build/api";
import type { Cast, NeynarWebhookData } from "../types";

export interface IInteractionProcessor {
  processMention(cast: NeynarCast): Promise<void>;
  processReply(cast: NeynarCast): Promise<void>;
  ensureCastConnection(cast: Cast): Promise<Memory>;
  processWebhookData(webhookData: NeynarWebhookData): Promise<void>;
}
