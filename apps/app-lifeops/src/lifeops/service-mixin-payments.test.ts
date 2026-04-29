import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LifeOpsPaymentSource } from "./payment-types.js";
import {
  encryptPaymentMetadataToken,
  readPaymentMetadataToken,
  sanitizePaymentSourceForClient,
} from "./service-mixin-payments.js";

function source(metadata: Record<string, unknown>): LifeOpsPaymentSource {
  return {
    id: "source-1",
    agentId: "agent-1",
    kind: "plaid",
    label: "Bank",
    institution: "Bank",
    accountMask: "1234",
    status: "active",
    lastSyncedAt: null,
    transactionCount: 0,
    metadata,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

describe("sanitizePaymentSourceForClient", () => {
  it("removes Plaid and PayPal token metadata before source DTOs reach the client", () => {
    const sanitized = sanitizePaymentSourceForClient(
      source({
        plaid: { accessToken: "access-secret", cursor: "cursor" },
        paypal: {
          accessToken: "paypal-access",
          refreshToken: "paypal-refresh",
        },
        display: { color: "blue" },
      }),
    );

    expect(sanitized.metadata).toEqual({ display: { color: "blue" } });
  });

  it("does not mutate the repository object", () => {
    const raw = source({ plaid: { accessToken: "access-secret" } });
    const sanitized = sanitizePaymentSourceForClient(raw);

    expect(sanitized).not.toBe(raw);
    expect(raw.metadata).toEqual({ plaid: { accessToken: "access-secret" } });
  });
});

describe("payment metadata token encryption", () => {
  it("round-trips payment tokens without storing plaintext in metadata", () => {
    const env = {
      ELIZA_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
      ELIZA_OAUTH_DIR: "/tmp/milady-payment-token-test",
    } as NodeJS.ProcessEnv;

    const encrypted = encryptPaymentMetadataToken("plaid-access-secret", env);

    expect(JSON.stringify(encrypted)).not.toContain("plaid-access-secret");
    expect(readPaymentMetadataToken(encrypted, "Plaid access", env)).toBe(
      "plaid-access-secret",
    );
  });

  it("keeps legacy plaintext token reads working for existing payment sources", () => {
    const env = {
      ELIZA_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
      ELIZA_OAUTH_DIR: "/tmp/milady-payment-token-test",
    } as NodeJS.ProcessEnv;

    expect(readPaymentMetadataToken("legacy-access-token", "Plaid access", env))
      .toBe("legacy-access-token");
  });

  it("rejects malformed token metadata instead of treating it as empty", () => {
    const env = {
      ELIZA_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
      ELIZA_OAUTH_DIR: "/tmp/milady-payment-token-test",
    } as NodeJS.ProcessEnv;

    expect(() =>
      readPaymentMetadataToken({ accessToken: "plain" }, "Plaid access", env),
    ).toThrow(/token metadata is malformed/);
  });
});
