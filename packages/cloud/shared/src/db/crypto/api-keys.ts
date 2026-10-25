/**
 * API-key plaintext encryption helpers (D-1).
 *
 * The plaintext API key itself is sensitive (it grants access). A SHA-256
 * `key_hash` is stored for fast lookup during auth, while the raw plaintext is
 * encrypted at rest under the org's DEK so a DB-only compromise cannot
 * exfiltrate live keys.
 *
 * The one-time reveal flow on creation works by decrypting in-memory right
 * after insert — the plaintext never persists outside the encrypted columns.
 */

import { decryptField, type EncryptedField, encryptField, type FieldCoords } from "./field-crypto";

const COORDS = (rowId: string): FieldCoords => ({
  table: "api_keys",
  rowId,
  column: "key",
});

/**
 * Encrypt an API-key plaintext for storage. `rowId` is the api_keys.id UUID
 * of the row we are about to write.
 */
export async function encryptApiKey(
  orgId: string,
  rowId: string,
  plaintextKey: string,
): Promise<EncryptedField> {
  return encryptField(orgId, plaintextKey, COORDS(rowId));
}

/**
 * Decrypt an API-key plaintext from the encrypted columns.
 */
export async function decryptApiKey(rowId: string, field: EncryptedField): Promise<string> {
  return decryptField(field, COORDS(rowId));
}
