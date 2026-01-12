import type { Memory } from "@elizaos/core";
import type { Cast as NeynarCast } from "@neynar/nodejs-sdk/build/api";
import type { Cast, NeynarWebhookData } from "../types";

export interface IInteractionProcessor {
  processMention(cast: NeynarCast): Promise<void>;
  processReply(cast: NeynarCast): Promise<void>;
  ensureCastConnection(cast: Cast): Promise<Memory>;
  processWebhookData(webhookData: NeynarWebhookData): Promise<void>;
}
