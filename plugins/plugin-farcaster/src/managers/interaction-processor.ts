import type { Cast, NeynarWebhookData } from '../common/types';
import type { Cast as NeynarCast } from '@neynar/nodejs-sdk/build/api';

/**
 * Interface for interaction processing to break circular dependency
 */
export interface IInteractionProcessor {
  processMention(cast: NeynarCast): Promise<void>;
  processReply(cast: NeynarCast): Promise<void>;
  ensureCastConnection(cast: Cast): Promise<any>;
  processWebhookData(webhookData: NeynarWebhookData): Promise<void>;
}
