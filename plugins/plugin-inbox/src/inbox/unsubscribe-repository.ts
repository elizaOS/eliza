import type { IAgentRuntime } from "@elizaos/core";
import {
  executeRawSql,
  parseJsonRecord,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
  toBoolean,
  toNumber,
  toText,
} from "../db/sql.ts";
import type {
  EmailUnsubscribeMethod,
  EmailUnsubscribeRecord,
  EmailUnsubscribeStatus,
} from "./email-unsubscribe-types.ts";

/**
 * Raw-SQL repository for the email-unsubscribe history.
 *
 * Reads/writes `app_inbox.life_email_unsubscribes`, the table PA still
 * registers + migrates (no data migration — the table name is preserved). Same
 * pattern as {@link InboxRepository}: a thin raw-SQL wrapper over the runtime DB
 * handle so this plugin carries no `@elizaos/plugin-personal-assistant`
 * dependency.
 */
function parseEmailUnsubscribe(
  row: Record<string, unknown>,
): EmailUnsubscribeRecord {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    senderEmail: toText(row.sender_email),
    senderDisplay: toText(row.sender_display),
    senderDomain: row.sender_domain ? toText(row.sender_domain) : null,
    listId: row.list_id ? toText(row.list_id) : null,
    method: toText(row.method, "manual_only") as EmailUnsubscribeMethod,
    status: toText(row.status, "failed") as EmailUnsubscribeStatus,
    httpStatusCode:
      row.http_status_code === null || row.http_status_code === undefined
        ? null
        : toNumber(row.http_status_code, 0),
    httpFinalUrl: row.http_final_url ? toText(row.http_final_url) : null,
    filterCreated: toBoolean(row.filter_created),
    filterId: row.filter_id ? toText(row.filter_id) : null,
    threadsTrashed: toNumber(row.threads_trashed, 0),
    errorMessage: row.error_message ? toText(row.error_message) : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export class InboxUnsubscribeRepository {
  constructor(private readonly runtime: IAgentRuntime) {}

  private get agentId(): string {
    return this.runtime.agentId;
  }

  async createEmailUnsubscribe(record: EmailUnsubscribeRecord): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_inbox.life_email_unsubscribes (
        id, agent_id, sender_email, sender_display, sender_domain, list_id,
        method, status, http_status_code, http_final_url, filter_created,
        filter_id, threads_trashed, error_message, metadata_json,
        created_at, updated_at
      ) VALUES (
        ${sqlQuote(record.id)},
        ${sqlQuote(record.agentId)},
        ${sqlQuote(record.senderEmail)},
        ${sqlQuote(record.senderDisplay)},
        ${sqlText(record.senderDomain)},
        ${sqlText(record.listId)},
        ${sqlQuote(record.method)},
        ${sqlQuote(record.status)},
        ${record.httpStatusCode === null ? "NULL" : sqlInteger(record.httpStatusCode)},
        ${sqlText(record.httpFinalUrl)},
        ${sqlBoolean(record.filterCreated)},
        ${sqlText(record.filterId)},
        ${sqlInteger(record.threadsTrashed)},
        ${sqlText(record.errorMessage)},
        ${sqlJson(record.metadata)},
        ${sqlQuote(record.createdAt)},
        ${sqlQuote(record.updatedAt)}
      )`,
    );
  }

  async listEmailUnsubscribes(
    args: { limit?: number } = {},
  ): Promise<EmailUnsubscribeRecord[]> {
    const limit = Math.max(1, Math.min(500, Math.trunc(args.limit ?? 100)));
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_inbox.life_email_unsubscribes
        WHERE agent_id = ${sqlQuote(this.agentId)}
        ORDER BY created_at DESC
        LIMIT ${limit}`,
    );
    return rows.map(parseEmailUnsubscribe);
  }

  async getEmailUnsubscribe(
    id: string,
  ): Promise<EmailUnsubscribeRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_inbox.life_email_unsubscribes
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND id = ${sqlQuote(id)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseEmailUnsubscribe(row) : null;
  }

  async findEmailUnsubscribeBySender(
    senderEmail: string,
  ): Promise<EmailUnsubscribeRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_inbox.life_email_unsubscribes
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND sender_email = ${sqlQuote(senderEmail.trim().toLowerCase())}
        ORDER BY created_at DESC
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseEmailUnsubscribe(row) : null;
  }
}
