/**
 * Behavioral unit tests for conversation-message content encryption.
 *
 * Drives the real `encryptConversationContent` / `decryptConversationContent`
 * helpers through the in-process MemoryKmsAdapter selected when NODE_ENV=test.
 * Ciphertext is bound to `conversation_messages` + message id + `content` via
 * AAD; these cases record that binding and the AEAD fail-closed paths.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { decryptConversationContent, encryptConversationContent } from "./conversations";
import type { EncryptedField } from "./field-crypto";
import { resetKmsClientForTests } from "./kms-client";

const ORG_A = "org-conversations-a";
const ORG_B = "org-conversations-b";
const MESSAGE_A = "00000000-0000-4000-8000-0000000000aa";
const MESSAGE_B = "00000000-0000-4000-8000-0000000000bb";

beforeEach(() => {
  resetKmsClientForTests();
});

function xorFirstByte(b64: string): string {
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0) {
    throw new Error("expected non-empty base64 payload");
  }
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return bytes.toString("base64");
}

describe("encryptConversationContent / decryptConversationContent", () => {
  test("round-trips ordinary UTF-8 content", async () => {
    const plaintext = "hello world";
    const enc = await encryptConversationContent(ORG_A, MESSAGE_A, plaintext);
    expect(await decryptConversationContent(MESSAGE_A, enc)).toBe(plaintext);
  });

  test("round-trips an empty string", async () => {
    const enc = await encryptConversationContent(ORG_A, MESSAGE_A, "");
    expect(await decryptConversationContent(MESSAGE_A, enc)).toBe("");
  });

  test("round-trips a single character", async () => {
    const enc = await encryptConversationContent(ORG_A, MESSAGE_A, "x");
    expect(await decryptConversationContent(MESSAGE_A, enc)).toBe("x");
  });

  test("preserves leading/trailing whitespace (no normalization)", async () => {
    const plaintext = "  keep me  \n";
    const enc = await encryptConversationContent(ORG_A, MESSAGE_A, plaintext);
    expect(await decryptConversationContent(MESSAGE_A, enc)).toBe(plaintext);
  });

  test("round-trips unicode, emoji, and newlines", async () => {
    const plaintext = "hello — 世界\n🚀\tline two";
    const enc = await encryptConversationContent(ORG_A, MESSAGE_A, plaintext);
    expect(await decryptConversationContent(MESSAGE_A, enc)).toBe(plaintext);
  });

  test("round-trips a long payload", async () => {
    const plaintext = "msg-".repeat(4096);
    const enc = await encryptConversationContent(ORG_A, MESSAGE_A, plaintext);
    expect(await decryptConversationContent(MESSAGE_A, enc)).toBe(plaintext);
  });

  test("returns a complete EncryptedField envelope that does not leak plaintext", async () => {
    const plaintext = "secret conversation body";
    const enc = await encryptConversationContent(ORG_A, MESSAGE_A, plaintext);
    expect(enc.ciphertext.length).toBeGreaterThan(0);
    expect(enc.nonce.length).toBeGreaterThan(0);
    expect(enc.auth_tag.length).toBeGreaterThan(0);
    expect(enc.kms_key_id.length).toBeGreaterThan(0);
    expect(enc.kms_key_version).toBeGreaterThanOrEqual(1);
    expect(enc.ciphertext).not.toContain(plaintext);
    expect(Buffer.from(enc.ciphertext, "base64").toString("utf8")).not.toContain(plaintext);
  });

  test("two encrypts of the same plaintext produce distinct nonce and ciphertext", async () => {
    const plaintext = "same body twice";
    const a = await encryptConversationContent(ORG_A, MESSAGE_A, plaintext);
    const b = await encryptConversationContent(ORG_A, MESSAGE_A, plaintext);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(await decryptConversationContent(MESSAGE_A, a)).toBe(plaintext);
    expect(await decryptConversationContent(MESSAGE_A, b)).toBe(plaintext);
  });

  test("ciphertext is bound to the message id (AAD) — cross-row decrypt fails closed", async () => {
    const enc = await encryptConversationContent(ORG_A, MESSAGE_A, "bound to A");
    expect(await decryptConversationContent(MESSAGE_A, enc)).toBe("bound to A");
    await expect(decryptConversationContent(MESSAGE_B, enc)).rejects.toThrow();
  });

  test("swapping envelopes across message ids fails closed in both directions", async () => {
    const encA = await encryptConversationContent(ORG_A, MESSAGE_A, "alpha");
    const encB = await encryptConversationContent(ORG_A, MESSAGE_B, "beta");
    await expect(decryptConversationContent(MESSAGE_B, encA)).rejects.toThrow();
    await expect(decryptConversationContent(MESSAGE_A, encB)).rejects.toThrow();
    expect(await decryptConversationContent(MESSAGE_A, encA)).toBe("alpha");
    expect(await decryptConversationContent(MESSAGE_B, encB)).toBe("beta");
  });

  test("tampered ciphertext fails closed", async () => {
    const enc = await encryptConversationContent(ORG_A, MESSAGE_A, "do not mutate");
    const tampered: EncryptedField = { ...enc, ciphertext: xorFirstByte(enc.ciphertext) };
    await expect(decryptConversationContent(MESSAGE_A, tampered)).rejects.toThrow();
  });

  test("tampered nonce fails closed", async () => {
    const enc = await encryptConversationContent(ORG_A, MESSAGE_A, "do not mutate");
    const tampered: EncryptedField = { ...enc, nonce: xorFirstByte(enc.nonce) };
    await expect(decryptConversationContent(MESSAGE_A, tampered)).rejects.toThrow();
  });

  test("tampered auth_tag fails closed", async () => {
    const enc = await encryptConversationContent(ORG_A, MESSAGE_A, "do not mutate");
    const tampered: EncryptedField = { ...enc, auth_tag: xorFirstByte(enc.auth_tag) };
    await expect(decryptConversationContent(MESSAGE_A, tampered)).rejects.toThrow();
  });

  test("decrypt uses the stored kms_key_id (org id is not an input to decrypt)", async () => {
    const plaintext = "org-agnostic decrypt";
    const enc = await encryptConversationContent(ORG_A, MESSAGE_A, plaintext);
    expect(enc.kms_key_id).toContain(ORG_A);
    expect(await decryptConversationContent(MESSAGE_A, enc)).toBe(plaintext);
  });

  test("different orgs encrypt under different key ids", async () => {
    const plaintext = "shared wording";
    const encA = await encryptConversationContent(ORG_A, MESSAGE_A, plaintext);
    const encB = await encryptConversationContent(ORG_B, MESSAGE_A, plaintext);
    expect(encA.kms_key_id).not.toBe(encB.kms_key_id);
    expect(encA.kms_key_id).toContain(ORG_A);
    expect(encB.kms_key_id).toContain(ORG_B);
    expect(await decryptConversationContent(MESSAGE_A, encA)).toBe(plaintext);
    expect(await decryptConversationContent(MESSAGE_A, encB)).toBe(plaintext);
  });
});
