/**
 * Field-level encryption helpers for `conversations.content` (D-3).
 *
 * NOTE: per the schema the actual message body lives on `conversation_messages.content`.
 * The PII slice in PLAN.md is the conversation content surface, so we expose
 * encrypt/decrypt for the `conversation_messages` rows and bind AAD by row id +
 * column.
 */

import { decryptField, type EncryptedField, encryptField } from "./field-crypto";

const TABLE = "conversation_messages";
const COLUMN = "content";

export async function encryptConversationContent(
  orgId: string,
  messageId: string,
  plaintext: string,
): Promise<EncryptedField> {
  return encryptField(orgId, plaintext, { table: TABLE, rowId: messageId, column: COLUMN });
}

export async function decryptConversationContent(
  messageId: string,
  field: EncryptedField,
): Promise<string> {
  return decryptField(field, { table: TABLE, rowId: messageId, column: COLUMN });
}
