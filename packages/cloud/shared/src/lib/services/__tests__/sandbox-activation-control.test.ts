import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

const encrypt = mock(async () => "sealed-activation-token");
const decrypt = mock(async () => "ab".repeat(32));

mock.module("../field-encryption", () => ({
  fieldEncryption: { encrypt, decrypt },
}));

import {
  createSandboxActivationToken,
  decryptSandboxActivationToken,
  hashSandboxActivationToken,
} from "../sandbox-activation-control";

const ORIGINAL_MASTER_KEY = process.env.SECRETS_MASTER_KEY;
const MASTER_KEY = "01".repeat(32);
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const SANDBOX_ID = "00000000-0000-4000-8000-000000000002";

beforeEach(() => {
  process.env.SECRETS_MASTER_KEY = MASTER_KEY;
  encrypt.mockClear();
  decrypt.mockClear();
  encrypt.mockImplementation(async () => "sealed-activation-token");
  decrypt.mockImplementation(async () => "ab".repeat(32));
});

afterAll(() => {
  if (ORIGINAL_MASTER_KEY === undefined) {
    delete process.env.SECRETS_MASTER_KEY;
  } else {
    process.env.SECRETS_MASTER_KEY = ORIGINAL_MASTER_KEY;
  }
});

describe("sandbox activation token custody", () => {
  test("mints 32 random bytes and encrypts with the exact sandbox-column AAD", async () => {
    const minted = await createSandboxActivationToken({
      sandboxId: SANDBOX_ID,
      organizationId: ORGANIZATION_ID,
    });

    expect(minted.token).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.tokenHash).toBe(createHash("sha256").update(minted.token).digest("hex"));
    expect(minted.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.tokenCiphertext).toBe("sealed-activation-token");
    expect(encrypt).toHaveBeenCalledWith(ORGANIZATION_ID, minted.token, {
      table: "agent_sandboxes",
      rowId: SANDBOX_ID,
      column: "activation_token_ciphertext",
    });
    expect(process.argv).not.toContain(minted.token);
  });

  test("decrypts with the same AAD and rejects a token/hash divergence", async () => {
    const token = "ab".repeat(32);
    const tokenHash = hashSandboxActivationToken(token);
    const sandbox = {
      id: SANDBOX_ID,
      activation_token_ciphertext: "sealed-activation-token",
      activation_token_hash: tokenHash,
    } as const;

    await expect(decryptSandboxActivationToken(sandbox)).resolves.toBe(token);
    expect(decrypt).toHaveBeenCalledWith("sealed-activation-token", {
      table: "agent_sandboxes",
      rowId: SANDBOX_ID,
      column: "activation_token_ciphertext",
    });

    await expect(
      decryptSandboxActivationToken({
        ...sandbox,
        activation_token_hash: "f".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "SANDBOX_ACTIVATION_TOKEN_INVALID" });
  });

  test("fails closed before field encryption when SECRETS_MASTER_KEY is unavailable", async () => {
    delete process.env.SECRETS_MASTER_KEY;

    await expect(
      createSandboxActivationToken({
        sandboxId: SANDBOX_ID,
        organizationId: ORGANIZATION_ID,
      }),
    ).rejects.toMatchObject({ code: "SANDBOX_ACTIVATION_TOKEN_UNAVAILABLE" });
    await expect(
      decryptSandboxActivationToken({
        id: SANDBOX_ID,
        activation_token_ciphertext: "sealed-activation-token",
        activation_token_hash: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "SANDBOX_ACTIVATION_TOKEN_UNAVAILABLE" });
    expect(encrypt).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });
});
