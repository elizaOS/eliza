/**
 * Behavioral unit tests for `platform_credentials` PII field encryption.
 *
 * Drives the real `encryptPlatformCredentialField` / `decryptPlatformCredentialField`
 * helpers through the in-process MemoryKmsAdapter selected when NODE_ENV=test.
 * Ciphertext is bound to `platform_credentials` + row id + column via AAD;
 * these cases record that binding, the three encrypted columns, and the AEAD
 * fail-closed paths. There is no same-named suite elsewhere in the repo.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { EncryptedField } from "./field-crypto";
import { resetKmsClientForTests } from "./kms-client";
import {
  decryptPlatformCredentialField,
  encryptPlatformCredentialField,
} from "./platform-credentials";

const ORG_A = "org-platform-credentials-a";
const ORG_B = "org-platform-credentials-b";
const ROW_A = "00000000-0000-4000-8000-0000000000aa";
const ROW_B = "00000000-0000-4000-8000-0000000000bb";

const COLUMNS = ["platform_user_id", "platform_email", "platform_display_name"] as const;

type Column = (typeof COLUMNS)[number];

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

describe("encryptPlatformCredentialField / decryptPlatformCredentialField", () => {
  test("round-trips each encrypted column independently", async () => {
    const values: Record<Column, string> = {
      platform_user_id: "discord:9999",
      platform_email: "alice@discord.example",
      platform_display_name: "Alice Example",
    };
    for (const column of COLUMNS) {
      const enc = await encryptPlatformCredentialField(ORG_A, ROW_A, column, values[column]);
      expect(await decryptPlatformCredentialField(ROW_A, column, enc)).toBe(values[column]);
    }
  });

  test("round-trips an empty string on every column", async () => {
    for (const column of COLUMNS) {
      const enc = await encryptPlatformCredentialField(ORG_A, ROW_A, column, "");
      expect(await decryptPlatformCredentialField(ROW_A, column, enc)).toBe("");
    }
  });

  test("round-trips a single character", async () => {
    const enc = await encryptPlatformCredentialField(ORG_A, ROW_A, "platform_user_id", "x");
    expect(await decryptPlatformCredentialField(ROW_A, "platform_user_id", enc)).toBe("x");
  });

  test("preserves leading/trailing whitespace (no email or display-name normalization)", async () => {
    const email = "  Alice@Example.COM  \n";
    const name = "  Display Name  ";
    const encEmail = await encryptPlatformCredentialField(ORG_A, ROW_A, "platform_email", email);
    const encName = await encryptPlatformCredentialField(
      ORG_A,
      ROW_A,
      "platform_display_name",
      name,
    );
    expect(await decryptPlatformCredentialField(ROW_A, "platform_email", encEmail)).toBe(email);
    expect(await decryptPlatformCredentialField(ROW_A, "platform_display_name", encName)).toBe(
      name,
    );
  });

  test("round-trips unicode, emoji, and newlines", async () => {
    const plaintext = "hello — 世界\n🚀\tline two";
    const enc = await encryptPlatformCredentialField(
      ORG_A,
      ROW_A,
      "platform_display_name",
      plaintext,
    );
    expect(await decryptPlatformCredentialField(ROW_A, "platform_display_name", enc)).toBe(
      plaintext,
    );
  });

  test("round-trips a long payload", async () => {
    const plaintext = "id-".repeat(4096);
    const enc = await encryptPlatformCredentialField(ORG_A, ROW_A, "platform_user_id", plaintext);
    expect(await decryptPlatformCredentialField(ROW_A, "platform_user_id", enc)).toBe(plaintext);
  });

  test("returns a complete EncryptedField envelope that does not leak plaintext", async () => {
    const plaintext = "secret-platform-user";
    const enc = await encryptPlatformCredentialField(ORG_A, ROW_A, "platform_user_id", plaintext);
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
    const a = await encryptPlatformCredentialField(ORG_A, ROW_A, "platform_email", plaintext);
    const b = await encryptPlatformCredentialField(ORG_A, ROW_A, "platform_email", plaintext);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(await decryptPlatformCredentialField(ROW_A, "platform_email", a)).toBe(plaintext);
    expect(await decryptPlatformCredentialField(ROW_A, "platform_email", b)).toBe(plaintext);
  });

  test("ciphertext is bound to the row id (AAD) — cross-row decrypt fails closed", async () => {
    const enc = await encryptPlatformCredentialField(
      ORG_A,
      ROW_A,
      "platform_user_id",
      "bound to A",
    );
    expect(await decryptPlatformCredentialField(ROW_A, "platform_user_id", enc)).toBe("bound to A");
    await expect(decryptPlatformCredentialField(ROW_B, "platform_user_id", enc)).rejects.toThrow();
  });

  test("swapping envelopes across row ids fails closed in both directions", async () => {
    const encA = await encryptPlatformCredentialField(ORG_A, ROW_A, "platform_email", "alpha");
    const encB = await encryptPlatformCredentialField(ORG_A, ROW_B, "platform_email", "beta");
    await expect(decryptPlatformCredentialField(ROW_B, "platform_email", encA)).rejects.toThrow();
    await expect(decryptPlatformCredentialField(ROW_A, "platform_email", encB)).rejects.toThrow();
    expect(await decryptPlatformCredentialField(ROW_A, "platform_email", encA)).toBe("alpha");
    expect(await decryptPlatformCredentialField(ROW_B, "platform_email", encB)).toBe("beta");
  });

  test("ciphertext is bound to the column (AAD) — cross-column decrypt fails closed", async () => {
    const enc = await encryptPlatformCredentialField(
      ORG_A,
      ROW_A,
      "platform_email",
      "alice@example.com",
    );
    expect(await decryptPlatformCredentialField(ROW_A, "platform_email", enc)).toBe(
      "alice@example.com",
    );
    await expect(decryptPlatformCredentialField(ROW_A, "platform_user_id", enc)).rejects.toThrow();
    await expect(
      decryptPlatformCredentialField(ROW_A, "platform_display_name", enc),
    ).rejects.toThrow();
  });

  test("swapping envelopes across columns fails closed in both directions", async () => {
    const encId = await encryptPlatformCredentialField(
      ORG_A,
      ROW_A,
      "platform_user_id",
      "discord:1",
    );
    const encName = await encryptPlatformCredentialField(
      ORG_A,
      ROW_A,
      "platform_display_name",
      "Ada",
    );
    await expect(
      decryptPlatformCredentialField(ROW_A, "platform_display_name", encId),
    ).rejects.toThrow();
    await expect(
      decryptPlatformCredentialField(ROW_A, "platform_user_id", encName),
    ).rejects.toThrow();
    expect(await decryptPlatformCredentialField(ROW_A, "platform_user_id", encId)).toBe(
      "discord:1",
    );
    expect(await decryptPlatformCredentialField(ROW_A, "platform_display_name", encName)).toBe(
      "Ada",
    );
  });

  test("tampered ciphertext fails closed", async () => {
    const enc = await encryptPlatformCredentialField(
      ORG_A,
      ROW_A,
      "platform_user_id",
      "do not mutate",
    );
    const tampered: EncryptedField = { ...enc, ciphertext: xorFirstByte(enc.ciphertext) };
    await expect(
      decryptPlatformCredentialField(ROW_A, "platform_user_id", tampered),
    ).rejects.toThrow();
  });

  test("tampered nonce fails closed", async () => {
    const enc = await encryptPlatformCredentialField(
      ORG_A,
      ROW_A,
      "platform_email",
      "do not mutate",
    );
    const tampered: EncryptedField = { ...enc, nonce: xorFirstByte(enc.nonce) };
    await expect(
      decryptPlatformCredentialField(ROW_A, "platform_email", tampered),
    ).rejects.toThrow();
  });

  test("tampered auth_tag fails closed", async () => {
    const enc = await encryptPlatformCredentialField(
      ORG_A,
      ROW_A,
      "platform_display_name",
      "do not mutate",
    );
    const tampered: EncryptedField = { ...enc, auth_tag: xorFirstByte(enc.auth_tag) };
    await expect(
      decryptPlatformCredentialField(ROW_A, "platform_display_name", tampered),
    ).rejects.toThrow();
  });

  test("decrypt uses the stored kms_key_id (org id is not an input to decrypt)", async () => {
    const plaintext = "org-agnostic decrypt";
    const enc = await encryptPlatformCredentialField(ORG_A, ROW_A, "platform_user_id", plaintext);
    expect(enc.kms_key_id).toContain(ORG_A);
    expect(await decryptPlatformCredentialField(ROW_A, "platform_user_id", enc)).toBe(plaintext);
  });

  test("different orgs encrypt under different key ids", async () => {
    const plaintext = "shared wording";
    const encA = await encryptPlatformCredentialField(ORG_A, ROW_A, "platform_email", plaintext);
    const encB = await encryptPlatformCredentialField(ORG_B, ROW_A, "platform_email", plaintext);
    expect(encA.kms_key_id).not.toBe(encB.kms_key_id);
    expect(encA.kms_key_id).toContain(ORG_A);
    expect(encB.kms_key_id).toContain(ORG_B);
    expect(await decryptPlatformCredentialField(ROW_A, "platform_email", encA)).toBe(plaintext);
    expect(await decryptPlatformCredentialField(ROW_A, "platform_email", encB)).toBe(plaintext);
  });
});
