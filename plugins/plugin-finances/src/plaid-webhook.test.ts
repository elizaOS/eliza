/**
 * Deterministic unit tests for Plaid webhook verification and classification.
 * The harness is real cryptography: each case signs a compact ES256 JWT with a
 * locally generated P-256 key and verifies through {@link verifyPlaidWebhook}
 * with an in-memory key lookup — no network, no mocks of the code under test.
 */

import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FinancesServiceError } from "./finance-normalize.ts";
import {
  classifyPlaidWebhook,
  type PlaidWebhookPayload,
  verifyPlaidWebhook,
} from "./plaid-webhook.ts";

const subtle = webcrypto.subtle;

interface SignedWebhook {
  rawBody: string;
  verificationJwt: string;
  keyId: string;
  jwk: Record<string, unknown>;
}

async function signWebhook(args: {
  body: Record<string, unknown>;
  keyId?: string;
  iatOffsetSeconds?: number;
  bodyHashOverride?: string;
  alg?: string;
}): Promise<SignedWebhook> {
  const keyPair = await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = (await subtle.exportKey("jwk", keyPair.publicKey)) as Record<
    string,
    unknown
  >;
  const keyId = args.keyId ?? "test-key-1";
  const rawBody = JSON.stringify(args.body);
  const header = Buffer.from(
    JSON.stringify({ alg: args.alg ?? "ES256", kid: keyId, typ: "JWT" }),
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iat: Math.floor(Date.now() / 1000) + (args.iatOffsetSeconds ?? 0),
      request_body_sha256:
        args.bodyHashOverride ??
        createHash("sha256").update(rawBody, "utf8").digest("hex"),
    }),
  ).toString("base64url");
  const signature = Buffer.from(
    await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      Buffer.from(`${header}.${claims}`, "utf8"),
    ),
  ).toString("base64url");
  return {
    rawBody,
    verificationJwt: `${header}.${claims}.${signature}`,
    keyId,
    jwk,
  };
}

function keyLookup(signed: SignedWebhook) {
  return async (keyId: string) => {
    expect(keyId).toBe(signed.keyId);
    return { key: signed.jwk };
  };
}

const SYNC_BODY = {
  webhook_type: "TRANSACTIONS",
  webhook_code: "SYNC_UPDATES_AVAILABLE",
  item_id: "item-1",
};

describe("verifyPlaidWebhook", () => {
  it("accepts a correctly signed webhook and returns the parsed payload", async () => {
    const signed = await signWebhook({ body: SYNC_BODY });
    const payload = await verifyPlaidWebhook({
      rawBody: signed.rawBody,
      verificationJwt: signed.verificationJwt,
      getKey: keyLookup(signed),
    });
    expect(payload.webhook_code).toBe("SYNC_UPDATES_AVAILABLE");
    expect(payload.item_id).toBe("item-1");
  });

  it("rejects a tampered body (hash mismatch) with 401", async () => {
    const signed = await signWebhook({ body: SYNC_BODY });
    const tampered = JSON.stringify({ ...SYNC_BODY, item_id: "item-EVIL" });
    await expect(
      verifyPlaidWebhook({
        rawBody: tampered,
        verificationJwt: signed.verificationJwt,
        getKey: keyLookup(signed),
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a signature from a different key with 401", async () => {
    const signed = await signWebhook({ body: SYNC_BODY });
    const otherKey = await signWebhook({ body: SYNC_BODY });
    await expect(
      verifyPlaidWebhook({
        rawBody: signed.rawBody,
        verificationJwt: signed.verificationJwt,
        getKey: async () => ({ key: otherKey.jwk }),
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a stale (replayed) webhook with 401", async () => {
    const signed = await signWebhook({
      body: SYNC_BODY,
      iatOffsetSeconds: -601,
    });
    await expect(
      verifyPlaidWebhook({
        rawBody: signed.rawBody,
        verificationJwt: signed.verificationJwt,
        getKey: keyLookup(signed),
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects an unexpected alg with 401", async () => {
    const signed = await signWebhook({ body: SYNC_BODY, alg: "none" });
    await expect(
      verifyPlaidWebhook({
        rawBody: signed.rawBody,
        verificationJwt: signed.verificationJwt,
        getKey: keyLookup(signed),
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a non-JWT verification header with 401", async () => {
    await expect(
      verifyPlaidWebhook({
        rawBody: JSON.stringify(SYNC_BODY),
        verificationJwt: "not-a-jwt",
        getKey: async () => {
          throw new Error("must not be called");
        },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a signed but malformed (non-JSON / missing fields) body with 400", async () => {
    const malformed = await signWebhook({
      body: { webhook_type: "TRANSACTIONS" },
    });
    await expect(
      verifyPlaidWebhook({
        rawBody: malformed.rawBody,
        verificationJwt: malformed.verificationJwt,
        getKey: keyLookup(malformed),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("errors are FinancesServiceError instances", async () => {
    const signed = await signWebhook({ body: SYNC_BODY });
    await expect(
      verifyPlaidWebhook({
        rawBody: `${signed.rawBody} `,
        verificationJwt: signed.verificationJwt,
        getKey: keyLookup(signed),
      }),
    ).rejects.toBeInstanceOf(FinancesServiceError);
  });
});

describe("classifyPlaidWebhook", () => {
  const cases: Array<[string, string, string]> = [
    ["TRANSACTIONS", "SYNC_UPDATES_AVAILABLE", "sync"],
    ["TRANSACTIONS", "TRANSACTIONS_REMOVED", "sync"],
    ["TRANSACTIONS", "DEFAULT_UPDATE", "sync"],
    ["ITEM", "ERROR", "reauth"],
    ["ITEM", "PENDING_EXPIRATION", "reauth"],
    ["ITEM", "LOGIN_REPAIRED", "reauth"],
    ["ITEM", "USER_PERMISSION_REVOKED", "disconnect"],
    ["ITEM", "PENDING_DISCONNECT", "disconnect"],
    ["ITEM", "WEBHOOK_UPDATE_ACKNOWLEDGED", "none"],
    ["ASSETS", "PRODUCT_READY", "none"],
  ];
  for (const [type, code, action] of cases) {
    it(`${type}/${code} → ${action}`, () => {
      const payload: PlaidWebhookPayload = {
        webhook_type: type,
        webhook_code: code,
        item_id: "item-1",
      };
      expect(classifyPlaidWebhook(payload)).toBe(action);
    });
  }
});
