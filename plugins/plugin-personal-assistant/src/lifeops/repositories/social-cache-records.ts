/** Defines and parses social cache records for the LifeOps persistence boundary, preserving public factory and row contracts. */
import type {
  LifeOpsXDm,
  LifeOpsXFeedItem,
  LifeOpsXFeedType,
  LifeOpsXSyncState,
} from "@elizaos/shared";
import { parseJsonRecord, toBoolean, toText } from "../sql.js";

export function parseXDm(row: Record<string, unknown>): LifeOpsXDm {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    externalDmId: toText(row.external_dm_id),
    conversationId: toText(row.conversation_id),
    senderHandle: toText(row.sender_handle),
    senderId: toText(row.sender_id),
    isInbound: toBoolean(row.is_inbound),
    text: toText(row.text),
    receivedAt: toText(row.received_at),
    readAt: row.read_at ? toText(row.read_at) : null,
    repliedAt: row.replied_at ? toText(row.replied_at) : null,
    metadata: parseJsonRecord(row.metadata_json),
    syncedAt: toText(row.synced_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseXFeedItem(row: Record<string, unknown>): LifeOpsXFeedItem {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    externalTweetId: toText(row.external_tweet_id),
    authorHandle: toText(row.author_handle),
    authorId: toText(row.author_id),
    text: toText(row.text),
    createdAtSource: toText(row.created_at_source),
    feedType: toText(row.feed_type) as LifeOpsXFeedType,
    metadata: parseJsonRecord(row.metadata_json),
    syncedAt: toText(row.synced_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseXSyncState(
  row: Record<string, unknown>,
): LifeOpsXSyncState {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    feedType: toText(row.feed_type) as LifeOpsXFeedType,
    lastCursor: row.last_cursor ? toText(row.last_cursor) : null,
    syncedAt: toText(row.synced_at),
    updatedAt: toText(row.updated_at),
  };
}
