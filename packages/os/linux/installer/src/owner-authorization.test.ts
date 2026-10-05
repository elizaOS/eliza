import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Ed25519OwnerAuthorizationVerifier,
  ownerAuthorizationPayload,
} from "./owner-authorization";
import type { InstallAuthorization } from "./types";

const keys = generateKeyPairSync("ed25519");
function credential(): InstallAuthorization {
  const claims = {
    ownerId: "owner",
    planId: "a".repeat(64),
    inventoryFingerprint: "b".repeat(64),
    nonce: "nonce",
    issuedAt: "2026-09-25T00:00:00.000Z",
    expiresAt: "2026-09-25T00:05:00.000Z",
  };
  return {
    ...claims,
    credential: `ed25519-v1:${sign(null, ownerAuthorizationPayload(claims), keys.privateKey).toString("base64url")}`,
  };
}

describe("owner authorization signatures", () => {
  it("binds every owner approval claim", async () => {
    const verifier = new Ed25519OwnerAuthorizationVerifier(
      async () => keys.publicKey,
    );
    expect(await verifier.verify(credential())).toBe(true);
    for (const changes of [
      { ownerId: "other" },
      { planId: "c".repeat(64) },
      { inventoryFingerprint: "d".repeat(64) },
      { nonce: "other" },
      { issuedAt: "2026-09-25T00:01:00.000Z" },
      { expiresAt: "2026-09-25T00:06:00.000Z" },
    ])
      expect(await verifier.verify({ ...credential(), ...changes })).toBe(
        false,
      );
  });
  it("rejects unknown, revoked, wrong-key and malformed credentials", async () => {
    expect(
      await new Ed25519OwnerAuthorizationVerifier(async () => null).verify(
        credential(),
      ),
    ).toBe(false);
    const wrong = generateKeyPairSync("ed25519");
    expect(
      await new Ed25519OwnerAuthorizationVerifier(
        async () => wrong.publicKey,
      ).verify(credential()),
    ).toBe(false);
    const verifier = new Ed25519OwnerAuthorizationVerifier(
      async () => keys.publicKey,
    );
    for (const value of [
      "",
      "fixture-approved",
      `${credential().credential}=`,
      `ed25519-v1:${"A".repeat(85)}`,
    ])
      expect(
        await verifier.verify({ ...credential(), credential: value }),
      ).toBe(false);
  });
  it("preserves trusted key lookup failures and refuses private keys", async () => {
    const failure = new Error("key store unavailable");
    await expect(
      new Ed25519OwnerAuthorizationVerifier(async () => {
        throw failure;
      }).verify(credential()),
    ).rejects.toBe(failure);
    await expect(
      new Ed25519OwnerAuthorizationVerifier(async () => keys.privateKey).verify(
        credential(),
      ),
    ).rejects.toThrow("public key");
  });
  it("snapshots reviewed claims while the trusted key lookup is pending", async () => {
    const input = credential();
    const verifier = new Ed25519OwnerAuthorizationVerifier(async (ownerId) => {
      expect(ownerId).toBe("owner");
      input.ownerId = "changed";
      input.credential = "changed";
      return keys.publicKey;
    });
    expect(await verifier.verify(input)).toBe(true);
  });
  it("rejects invalid claim encodings before key lookup", async () => {
    const verifier = new Ed25519OwnerAuthorizationVerifier(async () => {
      throw new Error("unexpected lookup");
    });
    await expect(
      verifier.verify({ ...credential(), issuedAt: "yesterday" }),
    ).rejects.toThrow("Invalid owner authorization claims");
  });
});
