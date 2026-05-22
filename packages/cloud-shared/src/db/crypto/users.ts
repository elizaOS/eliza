/**
 * Field-level encryption helpers for `users` PII (D-3).
 *
 * Encrypted columns: email, phone_number, wallet_address, telegram_id,
 * discord_id. For email/phone/wallet we also maintain a deterministic
 * blind-index hash column so equality lookups still work without
 * decrypting every row.
 */

import {
  blindIndex,
  decryptField,
  type EncryptedField,
  encryptField,
  normalizeEmail,
  normalizePhone,
  normalizeWallet,
} from "./field-crypto";

const TABLE = "users";

type Column = "email" | "phone_number" | "wallet_address" | "telegram_id" | "discord_id";

export async function encryptUserField(
  orgId: string,
  userId: string,
  column: Column,
  plaintext: string,
): Promise<EncryptedField> {
  return encryptField(orgId, plaintext, { table: TABLE, rowId: userId, column });
}

export async function decryptUserField(
  userId: string,
  column: Column,
  field: EncryptedField,
): Promise<string> {
  return decryptField(field, { table: TABLE, rowId: userId, column });
}

// =============================================================================
// Blind-index hashes for lookup
// =============================================================================

export function emailBlindIndex(email: string): Promise<string> {
  return blindIndex(normalizeEmail(email), "users-email");
}

export function phoneBlindIndex(phone: string): Promise<string> {
  return blindIndex(normalizePhone(phone), "users-phone");
}

export function walletBlindIndex(address: string, chainType?: string | null): Promise<string> {
  return blindIndex(normalizeWallet(address, chainType), "users-wallet");
}
