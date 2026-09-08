/** Owns social cache persistence for LifeOps. Keeps domain mutations and existing transaction or claim boundaries together. */
import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsXDm,
  LifeOpsXFeedItem,
  LifeOpsXFeedType,
  LifeOpsXSyncState,
} from "@elizaos/shared";
import {
  executeRawSql,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
} from "../sql.js";
import {
  parseXDm,
  parseXFeedItem,
  parseXSyncState,
} from "./social-cache-records.js";
export class SocialCacheRepository {
  constructor(private readonly runtime: IAgentRuntime) {}
  async upsertXDm(dm: LifeOpsXDm): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_x_dms (
        id, agent_id, external_dm_id, conversation_id, sender_handle, sender_id,
        is_inbound, text, received_at, read_at, replied_at, metadata_json,
        synced_at, updated_at
      ) VALUES (
        ${sqlQuote(dm.id)},
        ${sqlQuote(dm.agentId)},
        ${sqlQuote(dm.externalDmId)},
        ${sqlQuote(dm.conversationId)},
        ${sqlQuote(dm.senderHandle)},
        ${sqlQuote(dm.senderId)},
        ${sqlBoolean(dm.isInbound)},
        ${sqlQuote(dm.text)},
        ${sqlQuote(dm.receivedAt)},
        ${sqlText(dm.readAt)},
        ${sqlText(dm.repliedAt)},
        ${sqlJson(dm.metadata)},
        ${sqlQuote(dm.syncedAt)},
        ${sqlQuote(dm.updatedAt)}
      )
      ON CONFLICT(agent_id, external_dm_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        sender_handle = excluded.sender_handle,
        sender_id = excluded.sender_id,
        is_inbound = excluded.is_inbound,
        text = excluded.text,
        received_at = excluded.received_at,
        read_at = COALESCE(excluded.read_at, app_lifeops.life_x_dms.read_at),
        replied_at = COALESCE(excluded.replied_at, app_lifeops.life_x_dms.replied_at),
        metadata_json = excluded.metadata_json,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at`,
    );
  }

  async listXDms(
    agentId: string,
    opts: { conversationId?: string; limit?: number } = {},
  ): Promise<LifeOpsXDm[]> {
    const limitClause =
      opts.limit !== undefined && Number.isFinite(opts.limit)
        ? `LIMIT ${sqlInteger(opts.limit)}`
        : "";
    const conversationClause = opts.conversationId
      ? `AND conversation_id = ${sqlQuote(opts.conversationId)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_x_dms
        WHERE agent_id = ${sqlQuote(agentId)}
          ${conversationClause}
        ORDER BY received_at DESC
        ${limitClause}`,
    );
    return rows.map(parseXDm);
  }

  async upsertXFeedItem(item: LifeOpsXFeedItem): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_x_feed_items (
        id, agent_id, external_tweet_id, author_handle, author_id, text,
        created_at_source, feed_type, metadata_json, synced_at, updated_at
      ) VALUES (
        ${sqlQuote(item.id)},
        ${sqlQuote(item.agentId)},
        ${sqlQuote(item.externalTweetId)},
        ${sqlQuote(item.authorHandle)},
        ${sqlQuote(item.authorId)},
        ${sqlQuote(item.text)},
        ${sqlQuote(item.createdAtSource)},
        ${sqlQuote(item.feedType)},
        ${sqlJson(item.metadata)},
        ${sqlQuote(item.syncedAt)},
        ${sqlQuote(item.updatedAt)}
      )
      ON CONFLICT(agent_id, external_tweet_id, feed_type) DO UPDATE SET
        author_handle = excluded.author_handle,
        author_id = excluded.author_id,
        text = excluded.text,
        created_at_source = excluded.created_at_source,
        metadata_json = excluded.metadata_json,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at`,
    );
  }

  async listXFeedItems(
    agentId: string,
    feedType: LifeOpsXFeedType,
    opts: { limit?: number } = {},
  ): Promise<LifeOpsXFeedItem[]> {
    const limitClause =
      opts.limit !== undefined && Number.isFinite(opts.limit)
        ? `LIMIT ${sqlInteger(opts.limit)}`
        : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_x_feed_items
        WHERE agent_id = ${sqlQuote(agentId)}
          AND feed_type = ${sqlQuote(feedType)}
        ORDER BY created_at_source DESC
        ${limitClause}`,
    );
    return rows.map(parseXFeedItem);
  }

  async upsertXSyncState(state: LifeOpsXSyncState): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_x_sync_states (
        id, agent_id, feed_type, last_cursor, synced_at, updated_at
      ) VALUES (
        ${sqlQuote(state.id)},
        ${sqlQuote(state.agentId)},
        ${sqlQuote(state.feedType)},
        ${sqlText(state.lastCursor)},
        ${sqlQuote(state.syncedAt)},
        ${sqlQuote(state.updatedAt)}
      )
      ON CONFLICT(agent_id, feed_type) DO UPDATE SET
        last_cursor = excluded.last_cursor,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at`,
    );
  }

  async getXSyncState(
    agentId: string,
    feedType: LifeOpsXFeedType,
  ): Promise<LifeOpsXSyncState | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_x_sync_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND feed_type = ${sqlQuote(feedType)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseXSyncState(row) : null;
  }
}
