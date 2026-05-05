import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  LifeOpsPaymentSource,
  LifeOpsPaymentTransaction,
} from "./payment-types.js";
import {
  encryptPaymentMetadataToken,
  readPaymentMetadataToken,
  sanitizePaymentSourceForClient,
  withPayments,
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
      ELIZA_OAUTH_DIR: "/tmp/eliza-payment-token-test",
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
      ELIZA_OAUTH_DIR: "/tmp/eliza-payment-token-test",
    } as NodeJS.ProcessEnv;

    expect(
      readPaymentMetadataToken("legacy-access-token", "Plaid access", env),
    ).toBe("legacy-access-token");
  });

  it("rejects malformed token metadata instead of treating it as empty", () => {
    const env = {
      ELIZA_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
      ELIZA_OAUTH_DIR: "/tmp/eliza-payment-token-test",
    } as NodeJS.ProcessEnv;

    expect(() =>
      readPaymentMetadataToken({ accessToken: "plain" }, "Plaid access", env),
    ).toThrow(/token metadata is malformed/);
  });
});

describe("getUpcomingBills", () => {
  class BareBase {
    public readonly runtime = {};

    constructor(public readonly repository: Record<string, unknown>) {}

    agentId(): string {
      return "agent-1";
    }
  }

  const PaymentsService = withPayments(
    BareBase as unknown as Parameters<typeof withPayments>[0],
  );

  function transaction(
    id: string,
    metadata: Record<string, unknown>,
  ): LifeOpsPaymentTransaction {
    return {
      id,
      agentId: "agent-1",
      sourceId: "email-source",
      externalId: `email:${id}`,
      postedAt: `2026-04-2${id.slice(-1)}T12:00:00.000Z`,
      amountUsd: 42,
      direction: "debit",
      merchantRaw: `Merchant ${id}`,
      merchantNormalized: `merchant-${id}`,
      description: null,
      category: "Bills",
      currency: "USD",
      metadata,
      createdAt: "2026-04-20T12:00:00.000Z",
    };
  }

  it("surfaces overdue and no-date extracted bills instead of hiding them", async () => {
    const repository = {
      listPaymentSources: async (): Promise<LifeOpsPaymentSource[]> => [
        {
          ...source({}),
          id: "email-source",
          kind: "email",
          label: "Email bills",
        },
      ],
      listPaymentTransactions: async (): Promise<
        LifeOpsPaymentTransaction[]
      > => [
        transaction("bill-1", {
          kind: "bill",
          dueDate: null,
          sourceMessageId: "message-1",
          confidence: 0.8,
        }),
        transaction("bill-2", {
          kind: "bill",
          dueDate: "2026-04-01",
          sourceMessageId: "message-2",
          confidence: 0.9,
        }),
        transaction("bill-3", {
          kind: "bill",
          dueDate: "2026-05-01",
          sourceMessageId: "message-3",
          confidence: 0.9,
        }),
        transaction("bill-4", {
          kind: "bill_paid",
          dueDate: "2026-05-01",
        }),
      ],
    };
    const service = new PaymentsService(repository);

    const bills = await service.getUpcomingBills({
      now: new Date("2026-04-26T12:00:00.000Z"),
    });

    expect(bills.map((bill) => [bill.id, bill.status])).toEqual([
      ["bill-2", "overdue"],
      ["bill-1", "needs_due_date"],
      ["bill-3", "upcoming"],
    ]);
  });
});
