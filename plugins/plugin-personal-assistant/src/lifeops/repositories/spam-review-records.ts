/** Defines and parses spam review records for the host persistence adapter, preserving canonical domain contracts. */
import type {
  LifeOpsGmailSpamReviewItem,
  LifeOpsGmailSpamReviewStatus,
} from "../../contracts/index.js";
import { parseJsonArray, toNumber, toText } from "../sql.js";

export function parseGmailSpamReviewItem(
  row: Record<string, unknown>,
): LifeOpsGmailSpamReviewItem {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    provider: "google",
    side: toText(row.side, "owner") as LifeOpsGmailSpamReviewItem["side"],
    grantId: toText(row.grant_id),
    accountEmail: row.account_email ? toText(row.account_email) : null,
    messageId: toText(row.message_id),
    externalMessageId: toText(row.external_message_id),
    threadId: toText(row.thread_id),
    subject: toText(row.subject),
    from: toText(row.from_display),
    fromEmail: row.from_email ? toText(row.from_email) : null,
    receivedAt: toText(row.received_at),
    snippet: toText(row.snippet),
    labels: parseJsonArray(row.label_ids_json),
    rationale: toText(row.rationale),
    confidence: toNumber(row.confidence),
    status: toText(row.status, "pending") as LifeOpsGmailSpamReviewStatus,
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
    reviewedAt: row.reviewed_at ? toText(row.reviewed_at) : null,
  };
}
