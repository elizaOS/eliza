/** Adapts LifeOps gmail persistence to canonical domain records. Preserves existing agent scoping, transaction handles, and conditional mutation contracts. */
import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsConnectorGrant,
  LifeOpsConnectorSide,
  LifeOpsGmailMessageSummary,
} from "../../contracts/index.js";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlInteger,
  sqlQuote,
  toNumber,
  withTransaction,
} from "../sql.js";
import {
  gmailMessageUpsertStatement,
  gmailSyncStateUpsertStatement,
  type LifeOpsGmailSyncState,
  parseGmailMessageSummary,
  parseGmailSyncState,
  requireScopedGmailGrantId,
} from "./gmail-records.js";
export class GmailRepository {
  constructor(private readonly runtime: IAgentRuntime) {}
  async upsertGmailMessage(
    message: LifeOpsGmailMessageSummary,
    side: LifeOpsConnectorSide = message.side,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      gmailMessageUpsertStatement(message, side),
    );
  }

  async publishGmailSeed(
    messages: readonly LifeOpsGmailMessageSummary[],
    state: LifeOpsGmailSyncState,
  ): Promise<void> {
    const grantId = requireScopedGmailGrantId(state.grantId);
    await withTransaction(this.runtime, async (tx) => {
      await executeRawSqlTx(
        tx,
        `DELETE FROM app_lifeops.life_gmail_messages
          WHERE agent_id = ${sqlQuote(state.agentId)}
            AND provider = ${sqlQuote(state.provider)}
            AND side = ${sqlQuote(state.side)}
            AND grant_id = ${sqlQuote(grantId)}`,
      );
      for (const message of messages) {
        const messageGrantId = requireScopedGmailGrantId(message.grantId);
        if (
          message.agentId !== state.agentId ||
          message.provider !== state.provider ||
          message.side !== state.side ||
          messageGrantId !== grantId
        ) {
          throw new Error(
            "Gmail seed message scope does not match its published sync state.",
          );
        }
        await executeRawSqlTx(
          tx,
          gmailMessageUpsertStatement(message, state.side),
        );
      }
      await executeRawSqlTx(tx, gmailSyncStateUpsertStatement(state));
    });
  }

  async pruneGmailMessages(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    keepExternalIds: readonly string[],
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<void> {
    const keepClause =
      keepExternalIds.length > 0
        ? `AND external_message_id NOT IN (${keepExternalIds
            .map((externalId) => sqlQuote(externalId))
            .join(", ")})`
        : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const grantClause = grantId ? `AND grant_id = ${sqlQuote(grantId)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_gmail_messages
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          ${grantClause}
          ${keepClause}`,
    );
  }

  async listGmailMessages(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    options?: {
      maxResults?: number;
      threadId?: string;
      since?: string;
      grantId?: string;
    },
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGmailMessageSummary[]> {
    const DEFAULT_GMAIL_LIST_LIMIT = 200;
    const limit =
      options?.maxResults !== undefined && Number.isFinite(options.maxResults)
        ? options.maxResults
        : DEFAULT_GMAIL_LIST_LIMIT;
    const maxResultsClause = `LIMIT ${sqlInteger(limit)}`;
    const threadClause = options?.threadId
      ? `AND thread_id = ${sqlQuote(options.threadId)}`
      : "";
    const sinceClause = options?.since
      ? `AND received_at >= ${sqlQuote(options.since)}`
      : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const grantClause = options?.grantId
      ? `AND grant_id = ${sqlQuote(options.grantId)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_gmail_messages
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          ${grantClause}
          ${threadClause}
          ${sinceClause}
        ORDER BY triage_score DESC, received_at DESC
        ${maxResultsClause}`,
    );
    return rows.map(parseGmailMessageSummary);
  }

  async countGmailMessages(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    side: LifeOpsConnectorSide,
    grantId: string,
  ): Promise<number> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT COUNT(*) AS message_count
         FROM app_lifeops.life_gmail_messages
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          AND side = ${sqlQuote(side)}
          AND grant_id = ${sqlQuote(grantId)}`,
    );
    return toNumber(rows[0]?.message_count, 0);
  }

  async getGmailMessage(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    messageId: string,
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsGmailMessageSummary | null> {
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const grantClause = grantId ? `AND grant_id = ${sqlQuote(grantId)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_gmail_messages
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          ${grantClause}
          AND id = ${sqlQuote(messageId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseGmailMessageSummary(row) : null;
  }

  async deleteGmailMessages(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    messageIds: readonly string[],
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const grantClause = grantId ? `AND grant_id = ${sqlQuote(grantId)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_gmail_messages
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          ${grantClause}
          AND id IN (${messageIds.map((messageId) => sqlQuote(messageId)).join(", ")})`,
    );
  }

  async deleteGmailMessagesByExternalId(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    externalMessageIds: readonly string[],
    side: LifeOpsConnectorSide,
    grantId: string,
  ): Promise<number> {
    if (externalMessageIds.length === 0) {
      return 0;
    }
    const rows = await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_gmail_messages
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          AND side = ${sqlQuote(side)}
          AND grant_id = ${sqlQuote(grantId)}
          AND external_message_id IN (${externalMessageIds
            .map((externalMessageId) => sqlQuote(externalMessageId))
            .join(", ")})
        RETURNING id`,
    );
    return rows.length;
  }

  async deleteGmailMessagesForProvider(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<void> {
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const grantClause = grantId ? `AND grant_id = ${sqlQuote(grantId)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_gmail_messages
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          ${grantClause}`,
    );
  }

  async upsertGmailSyncState(state: LifeOpsGmailSyncState): Promise<void> {
    await executeRawSql(this.runtime, gmailSyncStateUpsertStatement(state));
  }

  async getGmailSyncState(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    mailbox: string,
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsGmailSyncState | null> {
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const grantClause = grantId ? `AND grant_id = ${sqlQuote(grantId)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_gmail_sync_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          AND mailbox = ${sqlQuote(mailbox)}
          ${sideClause}
          ${grantClause}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseGmailSyncState(row) : null;
  }

  async deleteGmailSyncState(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    mailbox?: string,
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<void> {
    const mailboxClause = mailbox ? `AND mailbox = ${sqlQuote(mailbox)}` : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const grantClause = grantId ? `AND grant_id = ${sqlQuote(grantId)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_gmail_sync_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${mailboxClause}
          ${sideClause}
          ${grantClause}`,
    );
  }
}
