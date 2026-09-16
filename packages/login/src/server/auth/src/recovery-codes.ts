/**
 * Recovery codes — single-use backup codes for account recovery.
 *
 * When a user enables passkey/2FA, we issue a small batch (default 10) of
 * recovery codes. Each is a 14-character base32 string (Crockford alphabet,
 * I/L/O removed to avoid 1/0 confusion); legacy 10-character codes issued
 * before the length bump still verify. The plaintext is shown to the user
 * exactly once; the server stores only a salted hash. Verification compares
 * by hash (constant-time) and marks the code as used so it cannot be
 * replayed.
 *
 * Codes are formatted in groups of 5 ("ABCDE-FGHJK") for human readability
 * but stored without the separator. Verification is tolerant of casing and
 * separator placement so users typing them back work without UX rough edges.
 *
 * This module is storage-agnostic — callers supply a RecoveryCodeStore
 * (typically backed by a `user_recovery_codes` table) that persists hashes
 * and tracks which have been consumed.
 */

import { randomInt, timingSafeEqual } from "node:crypto";

import { hashSha256Hex } from "./crypto";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 chars, ambiguous removed
// 14 chars ≈ 69 bits: a dumped/decrypted store no longer yields codes to
// offline GPU cracking of a single salted SHA-256 (SEC-064). Legacy 10-char
// codes (~49.5 bits) remain verifiable so existing printouts keep working;
// rotating codes (regenerate) upgrades a user to the longer form.
const CODE_LEN = 14;
const LEGACY_CODE_LEN = 10;
const DEFAULT_BATCH = 10;
const SEPARATOR = "-";
const GROUP_SIZE = 5;

export interface StoredRecoveryCode {
  /** Opaque id assigned by the persistence layer (DB row PK, etc). */
  id: string;
  /** SHA-256 hex of the salt+normalized code. */
  hash: string;
  /** Per-code salt, hex. */
  salt: string;
  /** Set when the code is redeemed; non-null = unusable. */
  usedAt: Date | null;
}

export interface RecoveryCodeStore {
  /** Persist a fresh batch of codes for a user, replacing any prior codes. */
  replaceForUser(
    userId: string,
    codes: Array<{ hash: string; salt: string }>,
  ): Promise<void>;
  /** List all stored (active + used) codes for a user. */
  listForUser(userId: string): Promise<StoredRecoveryCode[]>;
  /** Mark a single code as consumed. Returns false when it was already used or missing. */
  markUsed(id: string, usedAt: Date): Promise<boolean>;
}

function generateOne(): string {
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return out;
}

/** Pretty-print a raw code as "ABCDE-FGHJK" without changing its identity. */
export function formatRecoveryCode(raw: string): string {
  const norm = normalize(raw);
  if (!isAcceptedCodeLength(norm.length)) return raw;
  const parts: string[] = [];
  for (let i = 0; i < norm.length; i += GROUP_SIZE) {
    parts.push(norm.slice(i, i + GROUP_SIZE));
  }
  return parts.join(SEPARATOR);
}

/** Strip whitespace + separators and uppercase; rejects anything outside the alphabet. */
export function normalize(input: string): string {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, "");
  for (const ch of cleaned) {
    if (!ALPHABET.includes(ch)) return "";
  }
  return cleaned;
}

function saltHex(): string {
  // 16 random bytes from the alphabet (re-using the same RNG path); 80 bits is
  // plenty for binding a single hash to a single code.
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return out;
}

function digest(salt: string, normalized: string): string {
  return hashSha256Hex(`${salt}:${normalized}`);
}

function isAcceptedCodeLength(length: number): boolean {
  return length === CODE_LEN || length === LEGACY_CODE_LEN;
}

/** Constant-time hex digest comparison (both sides are sha256 hex). */
function digestEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return timingSafeEqual(bufA, bufB);
}

/**
 * Generate `count` recovery codes for a user, persist their hashes, and
 * return the plaintext codes. The caller is responsible for displaying them
 * exactly once and warning the user that they will not be shown again.
 */
export async function generateRecoveryCodes(
  store: RecoveryCodeStore,
  userId: string,
  count: number = DEFAULT_BATCH,
): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1 || count > 32) {
    throw new Error("count must be an integer in [1, 32]");
  }
  const codes: string[] = [];
  const persisted: Array<{ hash: string; salt: string }> = [];
  for (let i = 0; i < count; i++) {
    const raw = generateOne();
    const salt = saltHex();
    codes.push(raw);
    persisted.push({ hash: digest(salt, raw), salt });
  }
  await store.replaceForUser(userId, persisted);
  return codes.map(formatRecoveryCode);
}

/**
 * Verify a user-supplied recovery code. On success the code is marked used
 * and `{ valid: true }` is returned. On failure (unknown code, already used,
 * malformed input) `{ valid: false }` is returned without leaking which
 * branch failed — callers should treat all failures identically.
 */
export async function verifyRecoveryCode(
  store: RecoveryCodeStore,
  userId: string,
  supplied: string,
): Promise<{ valid: boolean }> {
  const normalized = normalize(supplied);
  if (!isAcceptedCodeLength(normalized.length)) return { valid: false };

  const stored = await store.listForUser(userId);
  for (const row of stored) {
    if (row.usedAt) continue;
    if (digestEquals(digest(row.salt, normalized), row.hash)) {
      return { valid: await store.markUsed(row.id, new Date()) };
    }
  }
  return { valid: false };
}

/** Count of unused codes for a user, for surfacing "you have N left" in the UI. */
export async function unusedRecoveryCodeCount(
  store: RecoveryCodeStore,
  userId: string,
): Promise<number> {
  const all = await store.listForUser(userId);
  return all.filter((c) => !c.usedAt).length;
}

/**
 * Minimal in-memory RecoveryCodeStore — for tests and dev. NOT suitable for
 * production: codes vanish on restart and there is no cross-instance sharing.
 */
export class InMemoryRecoveryCodeStore implements RecoveryCodeStore {
  private byUser = new Map<string, StoredRecoveryCode[]>();
  private nextId = 1;

  async replaceForUser(
    userId: string,
    codes: Array<{ hash: string; salt: string }>,
  ): Promise<void> {
    this.byUser.set(
      userId,
      codes.map((c) => ({
        id: String(this.nextId++),
        hash: c.hash,
        salt: c.salt,
        usedAt: null,
      })),
    );
  }

  async listForUser(userId: string): Promise<StoredRecoveryCode[]> {
    return [...(this.byUser.get(userId) ?? [])];
  }

  async markUsed(id: string, usedAt: Date): Promise<boolean> {
    for (const list of this.byUser.values()) {
      const row = list.find((r) => r.id === id);
      if (row) {
        if (row.usedAt) return false;
        row.usedAt = usedAt;
        return true;
      }
    }
    return false;
  }
}
