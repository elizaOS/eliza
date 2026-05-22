/**
 * Field-level encryption helpers for `platform_credentials` PII (D-3).
 *
 * Encrypted columns: platform_user_id, platform_email, platform_display_name.
 */

import { decryptField, type EncryptedField, encryptField } from "./field-crypto";

const TABLE = "platform_credentials";

type Column = "platform_user_id" | "platform_email" | "platform_display_name";

export async function encryptPlatformCredentialField(
  orgId: string,
  rowId: string,
  column: Column,
  plaintext: string,
): Promise<EncryptedField> {
  return encryptField(orgId, plaintext, { table: TABLE, rowId, column });
}

export async function decryptPlatformCredentialField(
  rowId: string,
  column: Column,
  field: EncryptedField,
): Promise<string> {
  return decryptField(field, { table: TABLE, rowId, column });
}
