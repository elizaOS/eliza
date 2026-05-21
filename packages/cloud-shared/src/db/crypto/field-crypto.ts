/**
 * Field-level encryption primitives shared by the per-table helpers.
 *
 * All ciphertext columns are stored as base64 strings (text in Postgres);
 * `nonce` and `auth_tag` use the same encoding. Each encrypted field carries
 * its own `kms_key_id` + `kms_key_version` so that key rotation does not
 * break decrypt for older rows.
 *
 * AAD is always `${table}|${row_id}|${column}` (UTF-8 bytes). This binds
 * ciphertext to its row+column and prevents cross-row swaps even if an
 * attacker reads the raw bytes.
 */

import { orgKey, systemKey } from "@elizaos/security/kms";
import { getKmsClient } from "./kms-client";

export interface EncryptedField {
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  kms_key_id: string;
  kms_key_version: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function b64decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

function aadFor(table: string, rowId: string, column: string): Uint8Array {
  return enc.encode(`${table}|${rowId}|${column}`);
}

export interface FieldCoords {
  table: string;
  rowId: string;
  column: string;
}

/**
 * Encrypt a plaintext string for a given table/row/column with the org's DEK.
 */
export async function encryptField(
  orgId: string,
  plaintext: string,
  coords: FieldCoords,
): Promise<EncryptedField> {
  const kms = getKmsClient();
  const keyId = orgKey(orgId, "dek");
  await kms.getOrCreateKey(keyId);
  const result = await kms.encrypt(
    keyId,
    enc.encode(plaintext),
    aadFor(coords.table, coords.rowId, coords.column),
  );
  return {
    ciphertext: b64encode(result.ciphertext),
    nonce: b64encode(result.nonce),
    auth_tag: b64encode(result.authTag),
    kms_key_id: result.keyId,
    kms_key_version: result.keyVersion,
  };
}

/**
 * Decrypt a field encrypted with `encryptField`.
 */
export async function decryptField(field: EncryptedField, coords: FieldCoords): Promise<string> {
  const kms = getKmsClient();
  const plain = await kms.decrypt(
    field.kms_key_id,
    b64decode(field.ciphertext),
    b64decode(field.nonce),
    b64decode(field.auth_tag),
    aadFor(coords.table, coords.rowId, coords.column),
    field.kms_key_version,
  );
  return dec.decode(plain);
}

/**
 * Blind-index helper: HMAC-SHA256 with the system HMAC key, returns base64.
 *
 * The input is the *exact* normalized lookup value the caller wants to match
 * on. Per-column normalization (lowercase email, EIP-55 wallet) must happen
 * upstream before calling.
 */
export async function blindIndex(value: string, purpose: string): Promise<string> {
  const kms = getKmsClient();
  const keyId = systemKey(`blind-index-${purpose}`);
  await kms.getOrCreateKey(keyId);
  const tag = await kms.hmac(keyId, enc.encode(value));
  return b64encode(tag);
}

// =============================================================================
// Per-field-type normalization
// =============================================================================

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizePhone(phone: string): string {
  // Strip spaces, dashes, parens. Keep leading +.
  return phone.trim().replace(/[\s\-()]/g, "");
}

/**
 * Normalize a wallet address for blind-index hashing.
 *
 * - Solana / Bitcoin: case-sensitive (base58); return as-is after trim.
 * - EVM (0x-prefixed): lowercase. Strict EIP-55 checksumming is enforced
 *   upstream in repositories that already lowercase.
 * - Anything else: trim only.
 */
export function normalizeWallet(address: string, chainType?: string | null): string {
  const trimmed = address.trim();
  if (chainType === "evm" || trimmed.startsWith("0x")) {
    return trimmed.toLowerCase();
  }
  return trimmed;
}
