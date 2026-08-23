/**
 * Behavioral coverage for cloud-shared field encryption, HMAC blind-index, and
 * lookup-value normalization. Drives the real module against the in-process
 * MemoryKMS that `getKmsClient()` selects when NODE_ENV=test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { orgKey } from "@elizaos/core/security/kms";
import {
  blindIndex,
  decryptField,
  type EncryptedField,
  encryptField,
  normalizeEmail,
  normalizePhone,
  normalizeWallet,
} from "./field-crypto";
import { resetKmsClientForTests } from "./kms-client";

const ORG_A = "org-field-crypto-a";
const ORG_B = "org-field-crypto-b";
const COORDS = {
  table: "users",
  rowId: "00000000-0000-4000-8000-000000000001",
  column: "email",
};

beforeEach(() => {
  resetKmsClientForTests();
});

afterEach(() => {
  resetKmsClientForTests();
});

function xorFirstByte(b64: string): string {
  const bytes = Buffer.from(b64, "base64");
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return bytes.toString("base64");
}

describe("encryptField / decryptField", () => {
  test("round-trips empty, ASCII, whitespace, and UTF-8 plaintext", async () => {
    for (const plaintext of ["", "secret", "  padded  ", "hello — 世界", "emoji 🔐"]) {
      const field = await encryptField(ORG_A, plaintext, COORDS);
      expect(await decryptField(field, COORDS)).toBe(plaintext);
    }
  });

  test("returns base64 envelope fields and the org DEK identity", async () => {
    const field: EncryptedField = await encryptField(ORG_A, "payload", COORDS);
    expect(field.kms_key_id).toBe(orgKey(ORG_A, "dek"));
    expect(field.kms_key_version).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(field.kms_key_version)).toBe(true);
    for (const part of [field.ciphertext, field.nonce, field.auth_tag]) {
      expect(part.length).toBeGreaterThan(0);
      expect(Buffer.from(part, "base64").length).toBeGreaterThan(0);
    }
    expect(field.ciphertext).not.toContain("payload");
  });

  test("distinct orgs bind distinct DEK identifiers", async () => {
    const a = await encryptField(ORG_A, "same-plain", COORDS);
    const b = await encryptField(ORG_B, "same-plain", COORDS);
    expect(a.kms_key_id).toBe(orgKey(ORG_A, "dek"));
    expect(b.kms_key_id).toBe(orgKey(ORG_B, "dek"));
    expect(a.kms_key_id).not.toBe(b.kms_key_id);
  });

  test("repeated encrypts of the same plaintext use fresh nonces", async () => {
    const first = await encryptField(ORG_A, "same-plain", COORDS);
    const second = await encryptField(ORG_A, "same-plain", COORDS);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(await decryptField(first, COORDS)).toBe("same-plain");
    expect(await decryptField(second, COORDS)).toBe("same-plain");
  });

  test("empty table, row, and column coords still round-trip when they match", async () => {
    const emptyCoords = { table: "", rowId: "", column: "" };
    const field = await encryptField(ORG_A, "bound-to-empty-aad", emptyCoords);
    expect(await decryptField(field, emptyCoords)).toBe("bound-to-empty-aad");
  });

  test("AAD mismatch on table, row, or column fails closed", async () => {
    const field = await encryptField(ORG_A, "secret", COORDS);
    await expect(decryptField(field, { ...COORDS, table: "other" })).rejects.toThrow();
    await expect(decryptField(field, { ...COORDS, rowId: "row-b" })).rejects.toThrow();
    await expect(decryptField(field, { ...COORDS, column: "phone" })).rejects.toThrow();
  });

  test("tampered ciphertext, nonce, or auth tag fails closed", async () => {
    const field = await encryptField(ORG_A, "secret", COORDS);
    await expect(
      decryptField({ ...field, ciphertext: xorFirstByte(field.ciphertext) }, COORDS),
    ).rejects.toThrow();
    await expect(
      decryptField({ ...field, nonce: xorFirstByte(field.nonce) }, COORDS),
    ).rejects.toThrow();
    await expect(
      decryptField({ ...field, auth_tag: xorFirstByte(field.auth_tag) }, COORDS),
    ).rejects.toThrow();
  });

  test("decrypt after a memory-KMS reset fails closed because the DEK is gone", async () => {
    const field = await encryptField(ORG_A, "orphan-me", COORDS);
    resetKmsClientForTests();
    await expect(decryptField(field, COORDS)).rejects.toThrow();
  });
});

describe("blindIndex", () => {
  test("is deterministic for the same value and purpose", async () => {
    const a = await blindIndex("foo@bar.com", "users-email");
    const b = await blindIndex("foo@bar.com", "users-email");
    expect(a).toBe(b);
    expect(Buffer.from(a, "base64").length).toBeGreaterThan(0);
  });

  test("domain-separates purposes and values", async () => {
    const email = await blindIndex("alice", "users-email");
    const phone = await blindIndex("alice", "users-phone");
    const other = await blindIndex("bob", "users-email");
    expect(email).not.toBe(phone);
    expect(email).not.toBe(other);
  });

  test("indexes the empty string and unicode without throwing", async () => {
    const emptyA = await blindIndex("", "users-email");
    const emptyB = await blindIndex("", "users-email");
    expect(emptyA).toBe(emptyB);
    const unicode = await blindIndex("ユーザー@例.jp", "users-email");
    expect(unicode).not.toBe(emptyA);
    expect(Buffer.from(unicode, "base64").length).toBeGreaterThan(0);
  });
});

describe("normalizeEmail", () => {
  test("trims surrounding whitespace and lowercases", () => {
    expect(normalizeEmail("  FOO@BAR.com  ")).toBe("foo@bar.com");
    expect(normalizeEmail("foo@bar.com")).toBe("foo@bar.com");
    expect(normalizeEmail("   ")).toBe("");
    expect(normalizeEmail("")).toBe("");
  });
});

describe("normalizePhone", () => {
  test("strips spaces, dashes, and parentheses while keeping a leading plus", () => {
    expect(normalizePhone("+1 (555) 010-1234")).toBe("+15550101234");
    expect(normalizePhone("  555-0101234 ")).toBe("5550101234");
    expect(normalizePhone("+")).toBe("+");
    expect(normalizePhone("   ")).toBe("");
  });

  test("does not strip characters outside spaces, dashes, and parentheses", () => {
    expect(normalizePhone("+1.555.010.1234")).toBe("+1.555.010.1234");
    expect(normalizePhone("555/010/1234")).toBe("555/010/1234");
    expect(normalizePhone("ext 12")).toBe("ext12");
  });
});

describe("normalizeWallet", () => {
  test("lowercases EVM addresses via chainType even without a 0x prefix", () => {
    expect(normalizeWallet("ABCDEF", "evm")).toBe("abcdef");
    expect(normalizeWallet("  0xABCDEF  ", "evm")).toBe("0xabcdef");
  });

  test("lowercases any 0x-prefixed address regardless of chainType", () => {
    expect(normalizeWallet("0xABCDEF")).toBe("0xabcdef");
    expect(normalizeWallet("0xABCDEF", null)).toBe("0xabcdef");
    expect(normalizeWallet("0xABCDEF", "solana")).toBe("0xabcdef");
  });

  test("preserves case for non-EVM, non-0x addresses after trim", () => {
    const sol = "ABCdef123XYZ";
    expect(normalizeWallet(sol, "solana")).toBe(sol);
    expect(normalizeWallet(`  ${sol}  `, "bitcoin")).toBe(sol);
    expect(normalizeWallet(sol, null)).toBe(sol);
    expect(normalizeWallet(sol)).toBe(sol);
  });

  test("treats chainType as an exact lowercase match, so EVM without 0x stays as-is", () => {
    expect(normalizeWallet("AbCdEf", "EVM")).toBe("AbCdEf");
    expect(normalizeWallet("AbCdEf", "Evm")).toBe("AbCdEf");
  });

  test("trims whitespace-only input to an empty string", () => {
    expect(normalizeWallet("   ")).toBe("");
    expect(normalizeWallet("   ", "evm")).toBe("");
  });
});
