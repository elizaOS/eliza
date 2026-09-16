/** Defines and parses gmail records for the host persistence adapter, preserving canonical domain contracts. */

import crypto from "node:crypto";
import { ElizaError } from "@elizaos/core";
import type {
  LifeOpsConnectorGrant,
  LifeOpsConnectorSide,
  LifeOpsGmailMessageSummary,
} from "../../contracts/index.js";
import { deriveConnectorAccountId } from "../privacy-egress.js";
import {
  parseJsonArray,
  parseJsonRecord,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
  toBoolean,
  toNumber,
  toText,
} from "../sql.js";
import { isoNow } from "./record-values.js";

export function requireScopedGmailGrantId(
  grantId: string | null | undefined,
): string {
  if (typeof grantId !== "string" || grantId.trim().length === 0) {
    throw new Error("Gmail message persistence requires grantId.");
  }
  return grantId.trim();
}

export function parseGmailMessageSummary(
  row: Record<string, unknown>,
): LifeOpsGmailMessageSummary {
  return {
    id: toText(row.id),
    externalId: toText(row.external_message_id),
    agentId: toText(row.agent_id),
    provider: "google",
    side: toText(row.side, "owner") as LifeOpsGmailMessageSummary["side"],
    connectorAccountId: row.connector_account_id
      ? toText(row.connector_account_id)
      : undefined,
    grantId: row.grant_id ? toText(row.grant_id) : undefined,
    threadId: toText(row.thread_id),
    subject: toText(row.subject),
    from: toText(row.from_display),
    fromEmail: row.from_email ? toText(row.from_email) : null,
    replyTo: row.reply_to ? toText(row.reply_to) : null,
    to: parseJsonArray(row.to_json),
    cc: parseJsonArray(row.cc_json),
    snippet: toText(row.snippet),
    receivedAt: toText(row.received_at),
    isUnread: toBoolean(row.is_unread),
    isImportant: toBoolean(row.is_important),
    likelyReplyNeeded: toBoolean(row.likely_reply_needed),
    triageScore: toNumber(row.triage_score),
    triageReason: toText(row.triage_reason),
    labels: parseJsonArray(row.label_ids_json),
    htmlLink: row.html_link ? toText(row.html_link) : null,
    metadata: parseJsonRecord(row.metadata_json),
    syncedAt: toText(row.synced_at),
    updatedAt: toText(row.updated_at),
  };
}

export interface LifeOpsGmailSyncState {
  id: string;
  agentId: string;
  provider: LifeOpsConnectorGrant["provider"];
  side: LifeOpsConnectorSide;
  mailbox: string;
  grantId: string;
  maxResults: number;
  historyId: string | null;
  cursorStatus: "seeded" | "incremental" | "resynced";
  fullResyncReason: string | null;
  syncedAt: string;
  updatedAt: string;
}

export function parseGmailSyncState(
  row: Record<string, unknown>,
): LifeOpsGmailSyncState {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    provider: toText(row.provider) as LifeOpsConnectorGrant["provider"],
    side: toText(row.side, "owner") as LifeOpsConnectorSide,
    mailbox: toText(row.mailbox),
    grantId: toText(row.grant_id),
    maxResults: toNumber(row.max_results, 0),
    historyId: row.history_id ? toText(row.history_id) : null,
    cursorStatus: parseGmailCursorStatus(row.cursor_status),
    fullResyncReason: row.full_resync_reason
      ? toText(row.full_resync_reason)
      : null,
    syncedAt: toText(row.synced_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseGmailCursorStatus(
  value: unknown,
): LifeOpsGmailSyncState["cursorStatus"] {
  const status = toText(value, "seeded");
  if (
    status === "seeded" ||
    status === "incremental" ||
    status === "resynced"
  ) {
    return status;
  }
  throw new ElizaError("[LifeOpsRepository] Invalid Gmail cursor status", {
    code: "LIFEOPS_GMAIL_CURSOR_STATUS_INVALID",
    context: { status },
  });
}

export function gmailMessageUpsertStatement(
  message: LifeOpsGmailMessageSummary,
  side: LifeOpsConnectorSide,
): string {
  const grantId = requireScopedGmailGrantId(message.grantId);
  const connectorAccountId =
    message.connectorAccountId ??
    deriveConnectorAccountId({
      provider: message.provider,
      side,
      identityEmail: message.accountEmail,
      grantId,
    });
  return `INSERT INTO app_lifeops.life_gmail_messages (
      id, agent_id, provider, side, external_message_id,
      connector_account_id, grant_id, thread_id, subject, from_display,
      from_email, reply_to, to_json, cc_json, snippet, received_at,
      is_unread, is_important, likely_reply_needed, triage_score,
      triage_reason, label_ids_json, html_link, metadata_json, synced_at,
      updated_at
    ) VALUES (
      ${sqlQuote(message.id)},
      ${sqlQuote(message.agentId)},
      ${sqlQuote(message.provider)},
      ${sqlQuote(side)},
      ${sqlQuote(message.externalId)},
      ${sqlText(connectorAccountId)},
      ${sqlQuote(grantId)},
      ${sqlQuote(message.threadId)},
      ${sqlQuote(message.subject)},
      ${sqlQuote(message.from)},
      ${sqlText(message.fromEmail)},
      ${sqlText(message.replyTo)},
      ${sqlJson(message.to)},
      ${sqlJson(message.cc)},
      ${sqlQuote(message.snippet)},
      ${sqlQuote(message.receivedAt)},
      ${sqlBoolean(message.isUnread)},
      ${sqlBoolean(message.isImportant)},
      ${sqlBoolean(message.likelyReplyNeeded)},
      ${sqlInteger(message.triageScore)},
      ${sqlQuote(message.triageReason)},
      ${sqlJson(message.labels)},
      ${sqlText(message.htmlLink)},
      ${sqlJson(message.metadata)},
      ${sqlQuote(message.syncedAt)},
      ${sqlQuote(message.updatedAt)}
    )
    ON CONFLICT(agent_id, provider, side, grant_id, external_message_id) DO UPDATE SET
      id = excluded.id,
      connector_account_id = COALESCE(excluded.connector_account_id, app_lifeops.life_gmail_messages.connector_account_id),
      thread_id = excluded.thread_id,
      subject = excluded.subject,
      from_display = excluded.from_display,
      from_email = excluded.from_email,
      reply_to = excluded.reply_to,
      to_json = excluded.to_json,
      cc_json = excluded.cc_json,
      snippet = excluded.snippet,
      received_at = excluded.received_at,
      is_unread = excluded.is_unread,
      is_important = excluded.is_important,
      likely_reply_needed = excluded.likely_reply_needed,
      triage_score = excluded.triage_score,
      triage_reason = excluded.triage_reason,
      label_ids_json = excluded.label_ids_json,
      html_link = excluded.html_link,
      metadata_json = excluded.metadata_json,
      synced_at = excluded.synced_at,
      updated_at = excluded.updated_at`;
}

export function gmailSyncStateUpsertStatement(
  state: LifeOpsGmailSyncState,
): string {
  const grantId = requireScopedGmailGrantId(state.grantId);
  return `INSERT INTO app_lifeops.life_gmail_sync_states (
      id, agent_id, provider, side, mailbox, grant_id, max_results, history_id,
      cursor_status, full_resync_reason, synced_at, updated_at
    ) VALUES (
      ${sqlQuote(state.id)},
      ${sqlQuote(state.agentId)},
      ${sqlQuote(state.provider)},
      ${sqlQuote(state.side)},
      ${sqlQuote(state.mailbox)},
      ${sqlQuote(grantId)},
      ${sqlInteger(state.maxResults)},
      ${sqlText(state.historyId)},
      ${sqlQuote(state.cursorStatus)},
      ${sqlText(state.fullResyncReason)},
      ${sqlQuote(state.syncedAt)},
      ${sqlQuote(state.updatedAt)}
    )
    ON CONFLICT(agent_id, provider, side, grant_id, mailbox) DO UPDATE SET
      id = excluded.id,
      max_results = excluded.max_results,
      history_id = excluded.history_id,
      cursor_status = excluded.cursor_status,
      full_resync_reason = excluded.full_resync_reason,
      synced_at = excluded.synced_at,
      updated_at = excluded.updated_at`;
}

export function createLifeOpsGmailSyncState(
  params: Omit<
    LifeOpsGmailSyncState,
    "id" | "updatedAt" | "historyId" | "cursorStatus" | "fullResyncReason"
  > &
    Partial<
      Pick<
        LifeOpsGmailSyncState,
        "historyId" | "cursorStatus" | "fullResyncReason"
      >
    >,
): LifeOpsGmailSyncState {
  return {
    historyId: null,
    cursorStatus: "seeded",
    fullResyncReason: null,
    ...params,
    id: crypto.randomUUID(),
    updatedAt: isoNow(),
  };
}
