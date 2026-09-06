/** Adapts LifeOps spam review persistence to canonical domain records. Preserves existing agent scoping, transaction handles, and conditional mutation contracts. */
import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsConnectorGrant,
  LifeOpsConnectorSide,
  LifeOpsGmailSpamReviewItem,
  LifeOpsGmailSpamReviewStatus,
} from "../../contracts/index.js";
import {
  executeRawSql,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  toNumber,
} from "../sql.js";
import { parseGmailSpamReviewItem } from "./spam-review-records.js";
export class SpamReviewRepository {
  constructor(private readonly runtime: IAgentRuntime) {}
  async upsertGmailSpamReviewItem(
    item: LifeOpsGmailSpamReviewItem,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_gmail_spam_review_items (
        id, agent_id, provider, side, grant_id, account_email, message_id,
        external_message_id, thread_id, subject, from_display, from_email,
        received_at, snippet, label_ids_json, rationale, confidence, status,
        created_at, updated_at, reviewed_at
      ) VALUES (
        ${sqlQuote(item.id)},
        ${sqlQuote(item.agentId)},
        ${sqlQuote(item.provider)},
        ${sqlQuote(item.side)},
        ${sqlQuote(item.grantId)},
        ${sqlText(item.accountEmail)},
        ${sqlQuote(item.messageId)},
        ${sqlQuote(item.externalMessageId)},
        ${sqlQuote(item.threadId)},
        ${sqlQuote(item.subject)},
        ${sqlQuote(item.from)},
        ${sqlText(item.fromEmail)},
        ${sqlQuote(item.receivedAt)},
        ${sqlQuote(item.snippet)},
        ${sqlJson(item.labels)},
        ${sqlQuote(item.rationale)},
        ${sqlNumber(item.confidence)},
        ${sqlQuote(item.status)},
        ${sqlQuote(item.createdAt)},
        ${sqlQuote(item.updatedAt)},
        ${sqlText(item.reviewedAt)}
      )
      ON CONFLICT(agent_id, provider, side, grant_id, external_message_id) DO UPDATE SET
        account_email = excluded.account_email,
        message_id = excluded.message_id,
        thread_id = excluded.thread_id,
        subject = excluded.subject,
        from_display = excluded.from_display,
        from_email = excluded.from_email,
        received_at = excluded.received_at,
        snippet = excluded.snippet,
        label_ids_json = excluded.label_ids_json,
        rationale = excluded.rationale,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at`,
    );
  }

  async listGmailSpamReviewItems(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    options?: {
      maxResults?: number;
      status?: LifeOpsGmailSpamReviewStatus;
      grantId?: string;
    },
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGmailSpamReviewItem[]> {
    const limitClause =
      options?.maxResults !== undefined && Number.isFinite(options.maxResults)
        ? `LIMIT ${sqlInteger(options.maxResults)}`
        : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const statusClause = options?.status
      ? `AND status = ${sqlQuote(options.status)}`
      : "";
    const grantClause = options?.grantId
      ? `AND grant_id = ${sqlQuote(options.grantId)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_gmail_spam_review_items
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          ${statusClause}
          ${grantClause}
        ORDER BY updated_at DESC, received_at DESC
        ${limitClause}`,
    );
    return rows.map(parseGmailSpamReviewItem);
  }

  async countGmailSpamReviewItems(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    side: LifeOpsConnectorSide,
    grantId: string,
  ): Promise<number> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT COUNT(*) AS item_count
         FROM app_lifeops.life_gmail_spam_review_items
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          AND side = ${sqlQuote(side)}
          AND grant_id = ${sqlQuote(grantId)}`,
    );
    return toNumber(rows[0]?.item_count, 0);
  }

  async getGmailSpamReviewItem(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    itemId: string,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGmailSpamReviewItem | null> {
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_gmail_spam_review_items
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          AND id = ${sqlQuote(itemId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseGmailSpamReviewItem(row) : null;
  }

  async updateGmailSpamReviewItemStatus(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    itemId: string,
    status: LifeOpsGmailSpamReviewStatus,
    reviewedAt: string | null,
    updatedAt: string,
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_gmail_spam_review_items
          SET status = ${sqlQuote(status)},
              reviewed_at = ${sqlText(reviewedAt)},
              updated_at = ${sqlQuote(updatedAt)}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          AND id = ${sqlQuote(itemId)}`,
    );
  }

  async deleteGmailSpamReviewItemsForProvider(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<void> {
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const grantClause = grantId ? `AND grant_id = ${sqlQuote(grantId)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_gmail_spam_review_items
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          ${grantClause}`,
    );
  }
}
