/** Adapts LifeOps inbox cache persistence to canonical domain records. Preserves existing agent scoping, transaction handles, and conditional mutation contracts. */
import type { IAgentRuntime } from "@elizaos/core";
import type { LifeOpsInboxChannel } from "../../contracts/index.js";
import {
  deriveConnectorAccountId,
  grantScopedConnectorAccountId,
} from "../privacy-egress.js";
import {
  executeRawSql,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
} from "../sql.js";
import {
  hasOwnPriorityFlags,
  type LifeOpsCachedInboxMessage,
  type LifeOpsInboxCacheWriteMessage,
  normalizeInboxChannelValue,
  normalizeInboxChatType,
  normalizeInboxPriorityFlags,
  normalizeInboxWriteSourceRef,
  parseCachedInboxMessage,
} from "./inbox-cache-records.js";
import { isoNow } from "./record-values.js";
export class InboxCacheRepository {
  constructor(private readonly runtime: IAgentRuntime) {}
  async upsertCachedInboxMessages(
    agentId: string,
    messages: readonly LifeOpsInboxCacheWriteMessage[],
  ): Promise<void> {
    if (messages.length === 0) return;
    const now = isoNow();
    for (const message of messages) {
      const channel = normalizeInboxChannelValue(message.channel);
      const sourceRef = normalizeInboxWriteSourceRef(
        message.sourceRef,
        channel,
      );
      const chatType = normalizeInboxChatType(
        channel,
        message.chatType,
        message.participantCount,
      );
      const hasPriorityFlags = hasOwnPriorityFlags(message);
      const priorityFlags = normalizeInboxPriorityFlags(message.priorityFlags);
      const priorityFlagsUpdate = hasPriorityFlags
        ? "excluded.priority_flags_json"
        : "app_lifeops.life_inbox_messages.priority_flags_json";
      const connectorAccountId =
        message.connectorAccountId ??
        (channel === "gmail"
          ? (deriveConnectorAccountId({
              provider: "google",
              side: "owner",
              identityEmail: message.gmailAccountEmail,
              grantId: message.gmailAccountId,
            }) ??
            (message.gmailAccountId
              ? grantScopedConnectorAccountId({
                  provider: "google",
                  side: "owner",
                  grantId: message.gmailAccountId,
                })
              : null))
          : null);
      const gmailAccountId = message.gmailAccountId?.trim() || null;
      const gmailStoragePrefix =
        channel === "gmail" && gmailAccountId
          ? `gmail:${encodeURIComponent(gmailAccountId)}:`
          : null;
      const storageId = gmailStoragePrefix
        ? `${gmailStoragePrefix}${encodeURIComponent(sourceRef.externalId)}`
        : message.id;
      const storageExternalId =
        gmailStoragePrefix && gmailAccountId
          ? `${encodeURIComponent(gmailAccountId)}:${encodeURIComponent(sourceRef.externalId)}`
          : sourceRef.externalId;
      await executeRawSql(
        this.runtime,
        `INSERT INTO app_lifeops.life_inbox_messages (
          id, agent_id, channel, external_id, thread_id, sender_id,
          sender_display, sender_email, subject, snippet, received_at,
          is_unread, deep_link, source_ref_json, chat_type, participant_count,
          gmail_account_id, gmail_account_email, last_seen_at, replied_at, priority_score,
          priority_category, priority_flags_json, connector_account_id, cached_at, updated_at
        ) VALUES (
          ${sqlQuote(storageId)},
          ${sqlQuote(agentId)},
          ${sqlQuote(channel)},
          ${sqlQuote(storageExternalId)},
          ${sqlText(message.threadId)},
          ${sqlQuote(message.sender.id)},
          ${sqlQuote(message.sender.displayName)},
          ${sqlText(message.sender.email)},
          ${sqlText(message.subject)},
          ${sqlQuote(message.snippet)},
          ${sqlQuote(message.receivedAt)},
          ${sqlBoolean(message.unread)},
          ${sqlText(message.deepLink)},
          ${sqlJson(sourceRef)},
          ${sqlQuote(chatType)},
          ${sqlInteger(message.participantCount)},
          ${sqlText(gmailAccountId)},
          ${sqlText(message.gmailAccountEmail)},
          ${sqlText(message.lastSeenAt)},
          ${sqlText(message.repliedAt)},
          ${sqlInteger(message.priorityScore)},
          ${sqlText(message.priorityCategory)},
          ${sqlJson(priorityFlags)},
          ${sqlText(connectorAccountId)},
          ${sqlQuote(now)},
          ${sqlQuote(now)}
        )
        ON CONFLICT(agent_id, channel, external_id) DO UPDATE SET
          id = excluded.id,
          thread_id = excluded.thread_id,
          sender_id = excluded.sender_id,
          sender_display = excluded.sender_display,
          sender_email = excluded.sender_email,
          subject = excluded.subject,
          snippet = excluded.snippet,
          received_at = excluded.received_at,
          is_unread = excluded.is_unread,
          deep_link = excluded.deep_link,
          source_ref_json = excluded.source_ref_json,
          chat_type = excluded.chat_type,
          participant_count = excluded.participant_count,
          gmail_account_id = excluded.gmail_account_id,
          gmail_account_email = excluded.gmail_account_email,
          last_seen_at = COALESCE(excluded.last_seen_at, app_lifeops.life_inbox_messages.last_seen_at),
          replied_at = COALESCE(excluded.replied_at, app_lifeops.life_inbox_messages.replied_at),
          priority_score = COALESCE(excluded.priority_score, app_lifeops.life_inbox_messages.priority_score),
          priority_category = COALESCE(excluded.priority_category, app_lifeops.life_inbox_messages.priority_category),
          priority_flags_json = ${priorityFlagsUpdate},
          connector_account_id = COALESCE(excluded.connector_account_id, app_lifeops.life_inbox_messages.connector_account_id),
          cached_at = excluded.cached_at,
          updated_at = excluded.updated_at`,
      );
      if (gmailStoragePrefix && gmailAccountId) {
        // The pre-account-scoped cache key can coexist with the new key. Only
        // remove an exact same-account legacy row after the replacement is
        // durable, so a crash cannot discard the cached message.
        await executeRawSql(
          this.runtime,
          `DELETE FROM app_lifeops.life_inbox_messages
            WHERE agent_id = ${sqlQuote(agentId)}
              AND channel = ${sqlQuote("gmail")}
              AND gmail_account_id = ${sqlQuote(gmailAccountId)}
              AND external_id = ${sqlQuote(sourceRef.externalId)}
              AND id <> ${sqlQuote(storageId)}`,
        );
      }
    }
  }

  async listCachedInboxMessages(
    agentId: string,
    options?: {
      channels?: readonly LifeOpsInboxChannel[];
      maxResults?: number;
      gmailAccountId?: string;
    },
  ): Promise<LifeOpsCachedInboxMessage[]> {
    const channels =
      options?.channels?.map((channel) =>
        normalizeInboxChannelValue(channel),
      ) ?? [];
    const channelClause =
      channels.length > 0
        ? `AND channel IN (${channels
            .map((channel) => sqlQuote(channel))
            .join(", ")})`
        : "";
    const gmailAccountClause = options?.gmailAccountId
      ? `AND gmail_account_id = ${sqlQuote(options.gmailAccountId)}`
      : "";
    const limit =
      options?.maxResults !== undefined && Number.isFinite(options.maxResults)
        ? Math.max(1, Math.floor(options.maxResults))
        : 500;
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_inbox_messages
        WHERE agent_id = ${sqlQuote(agentId)}
          ${channelClause}
          ${gmailAccountClause}
        ORDER BY received_at DESC
        LIMIT ${sqlInteger(limit)}`,
    );
    return rows.map(parseCachedInboxMessage);
  }

  async markCachedInboxMessageRead(
    agentId: string,
    messageId: string,
    readAt = isoNow(),
  ): Promise<LifeOpsCachedInboxMessage | null> {
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_inbox_messages
          SET is_unread = ${sqlBoolean(false)},
              last_seen_at = ${sqlQuote(readAt)},
              updated_at = ${sqlQuote(readAt)}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(messageId)}`,
    );
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_inbox_messages
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(messageId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseCachedInboxMessage(row) : null;
  }
}
