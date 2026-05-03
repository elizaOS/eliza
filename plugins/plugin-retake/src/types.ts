/** Shape returned by GET /api/v1/agent/stream/comments */
export interface RetakeChatComment {
  chat_event_id: string;
  sender_user_id: string;
  sender_username: string;
  sender_display_name: string;
  sender_pfp: string;
  sender_wallet_address: string;
  streamer_id: string;
  session_id: string;
  text: string;
  timestamp: string;
  type: string;
}

/**
 * Re-export the canonical StreamingDestination from plugin-streaming-base.
 * Single source of truth — avoids duplicate definitions that can drift.
 */
export type { StreamingDestination } from "@elizaos/plugin-streaming-base";
