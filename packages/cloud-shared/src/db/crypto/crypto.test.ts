/**
 * Unit tests for the cloud-shared crypto helpers.
 *
 * Uses the in-process MemoryKmsAdapter (auto-selected when NODE_ENV=test
 * by `createKmsClient()` from `@elizaos/security/kms`).
 */

import { beforeEach, describe, expect, test } from "vitest";
import { decryptApiKey, encryptApiKey } from "./api-keys";
import { decryptConversationContent, encryptConversationContent } from "./conversations";
import {
  blindIndex,
  decryptField,
  encryptField,
  normalizeEmail,
  normalizePhone,
  normalizeWallet,
} from "./field-crypto";
import { resetKmsClientForTests } from "./kms-client";
import {
  decryptPlatformCredentialField,
  encryptPlatformCredentialField,
} from "./platform-credentials";
import {
  decryptUserField,
  emailBlindIndex,
  encryptUserField,
  phoneBlindIndex,
  walletBlindIndex,
} from "./users";

const ORG = "org-test-1";
const ROW = "00000000-0000-4000-8000-000000000001";
const ROW_B = "00000000-0000-4000-8000-000000000002";

beforeEach(() => {
  resetKmsClientForTests();
});

describe("field-crypto", () => {
  test("encrypt/decrypt round-trips a UTF-8 string", async () => {
    const coords = { table: "t1", rowId: ROW, column: "c1" };
    const enc = await encryptField(ORG, "hello — 世界", coords);
    expect(enc.ciphertext).toBeTruthy();
    expect(enc.nonce).toBeTruthy();
    expect(enc.auth_tag).toBeTruthy();
    expect(enc.kms_key_version).toBeGreaterThanOrEqual(1);
    const plain = await decryptField(enc, coords);
    expect(plain).toBe("hello — 世界");
  });

  test("AAD mismatch causes decrypt to fail", async () => {
    const coords = { table: "t1", rowId: ROW, column: "c1" };
    const enc = await encryptField(ORG, "secret", coords);
    await expect(
      decryptField(enc, { ...coords, rowId: ROW_B }),
    ).rejects.toThrow();
    await expect(
      decryptField(enc, { ...coords, column: "c2" }),
    ).rejects.toThrow();
    await expect(
      decryptField(enc, { ...coords, table: "other" }),
    ).rejects.toThrow();
  });

  test("blindIndex is deterministic for the same input", async () => {
    const a = await blindIndex("foo@bar.com", "users-email");
    const b = await blindIndex("foo@bar.com", "users-email");
    expect(a).toBe(b);
  });

  test("blindIndex purposes are domain-separated", async () => {
    const a = await blindIndex("alice", "users-email");
    const b = await blindIndex("alice", "users-phone");
    expect(a).not.toBe(b);
  });
});

describe("normalization", () => {
  test("email is case- and whitespace-insensitive", () => {
    expect(normalizeEmail("  FOO@BAR.com  ")).toBe("foo@bar.com");
    expect(normalizeEmail("foo@bar.com")).toBe("foo@bar.com");
  });

  test("phone strips formatting", () => {
    expect(normalizePhone("+1 (555) 010-1234")).toBe("+15550101234");
    expect(normalizePhone("  555-0101234 ")).toBe("5550101234");
  });

  test("wallet lowercases EVM but not Solana", () => {
    expect(normalizeWallet("0xABCDEF", "evm")).toBe("0xabcdef");
    expect(normalizeWallet("0xABCDEF")).toBe("0xabcdef");
    const sol = "ABCdef123XYZ"; // base58-ish
    expect(normalizeWallet(sol, "solana")).toBe(sol);
  });
});

describe("blind-index lookups", () => {
  test("email lookup matches across case/whitespace variants", async () => {
    const a = await emailBlindIndex("Alice@Example.COM");
    const b = await emailBlindIndex("  alice@example.com  ");
    expect(a).toBe(b);
  });

  test("phone lookup matches across formatting", async () => {
    const a = await phoneBlindIndex("+1 (555) 010-1234");
    const b = await phoneBlindIndex("+15550101234");
    expect(a).toBe(b);
  });

  test("wallet lookup is case-insensitive for EVM", async () => {
    const a = await walletBlindIndex("0xABCDef0123", "evm");
    const b = await walletBlindIndex("0xabcdef0123", "evm");
    expect(a).toBe(b);
  });
});

describe("api-keys crypto (D-1)", () => {
  test("encrypt/decrypt round-trips the plaintext key", async () => {
    const enc = await encryptApiKey(ORG, ROW, "eliza_abc123");
    expect(await decryptApiKey(ROW, enc)).toBe("eliza_abc123");
  });

  test("a different row id cannot decrypt the ciphertext (AAD bound)", async () => {
    const enc = await encryptApiKey(ORG, ROW, "eliza_abc123");
    await expect(decryptApiKey(ROW_B, enc)).rejects.toThrow();
  });
});

describe("user-field crypto (D-3)", () => {
  test("round-trips email and phone", async () => {
    const e1 = await encryptUserField(ORG, ROW, "email", "alice@example.com");
    expect(await decryptUserField(ROW, "email", e1)).toBe("alice@example.com");

    const e2 = await encryptUserField(ORG, ROW, "phone_number", "+15550101234");
    expect(await decryptUserField(ROW, "phone_number", e2)).toBe("+15550101234");
  });

  test("cross-column decrypt fails (AAD bound)", async () => {
    const enc = await encryptUserField(ORG, ROW, "email", "alice@example.com");
    await expect(decryptUserField(ROW, "phone_number", enc)).rejects.toThrow();
  });
});

describe("platform-credentials crypto (D-3)", () => {
  test("round-trips platform_user_id and platform_email", async () => {
    const a = await encryptPlatformCredentialField(ORG, ROW, "platform_user_id", "discord:9999");
    expect(await decryptPlatformCredentialField(ROW, "platform_user_id", a)).toBe("discord:9999");
    const b = await encryptPlatformCredentialField(ORG, ROW, "platform_email", "alice@discord");
    expect(await decryptPlatformCredentialField(ROW, "platform_email", b)).toBe("alice@discord");
  });
});

describe("conversation crypto (D-3)", () => {
  test("round-trips content with row-binding AAD", async () => {
    const enc = await encryptConversationContent(ORG, ROW, "hello world");
    expect(await decryptConversationContent(ROW, enc)).toBe("hello world");
    await expect(decryptConversationContent(ROW_B, enc)).rejects.toThrow();
  });
});
