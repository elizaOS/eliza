/** Exercises payment-request state and projection behavior with deterministic fixtures. */
import { describe, expect, test } from "bun:test";
import {
  type NewPaymentRequest,
  type PaymentRequestRow,
  PaymentRequestsRepository,
} from "../../db/repositories/payment-requests";
import { createPaymentRequestsService, toPublicPaymentRequest } from "./payment-requests";

class GuardedPaymentRequestsRepository extends PaymentRequestsRepository {
  createCalls = 0;

  override async createPaymentRequest(input: NewPaymentRequest): Promise<PaymentRequestRow> {
    this.createCalls += 1;
    throw new Error(`Unexpected payment request create for provider ${input.provider}`);
  }
}

function fakeRow(id: string, organizationId: string): PaymentRequestRow {
  return {
    id,
    organizationId,
    agentId: null,
    appId: null,
    provider: "stripe",
    amountCents: 100,
    currency: "USD",
    reason: null,
    paymentContext: { kind: "any_payer" },
    payerIdentityId: null,
    payerUserId: null,
    payerOrganizationId: organizationId,
    status: "expired",
    hostedUrl: null,
    callbackUrl: null,
    callbackSecret: null,
    providerIntent: {},
    settledAt: null,
    settlementTxRef: null,
    settlementProof: null,
    expiresAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    metadata: {},
  };
}

describe("toPublicPaymentRequest", () => {
  test("returns an explicit checkout DTO and excludes every internal field", () => {
    const row: PaymentRequestRow = {
      ...fakeRow("pr-public", "org-secret"),
      agentId: "agent-secret",
      appId: "app-secret",
      reason: "Premium plan",
      payerIdentityId: "identity-secret",
      payerUserId: "user-secret",
      payerOrganizationId: "payer-org-secret",
      status: "delivered",
      hostedUrl: "https://checkout.example.test/session",
      callbackUrl: "https://merchant.example.test/callback",
      callbackSecret: "callback-secret",
      providerIntent: { sessionSecret: "provider-secret" },
      settlementTxRef: "settlement-secret",
      settlementProof: { signature: "proof-secret" },
      metadata: { internal: "metadata-secret" },
    };

    expect(toPublicPaymentRequest(row, new Date(1))).toEqual({
      id: "pr-public",
      provider: "stripe",
      amountCents: 100,
      currency: "USD",
      reason: "Premium plan",
      status: "expired",
      hostedUrl: null,
      expiresAt: new Date(0),
    });
  });

  test("preserves the hosted URL for non-expired terminal rows", () => {
    const row = {
      ...fakeRow("pr-settled-public", "org-secret"),
      status: "settled" as const,
      hostedUrl: "https://checkout.example.test/session",
    };

    expect(toPublicPaymentRequest(row, new Date(1)).hostedUrl).toBe(row.hostedUrl);
  });
});

/**
 * Records which expire path the service took. The GLOBAL sweep throws so any
 * regression that reintroduces the cross-tenant sweep (#10117) fails loudly.
 */
class ExpireScopingRepository extends PaymentRequestsRepository {
  forOrgCalls: Array<{ organizationId: string; now: Date }> = [];
  private readonly orgById: Record<string, string>;

  constructor(orgById: Record<string, string>) {
    super();
    this.orgById = orgById;
  }

  override async expirePastPaymentRequests(_now: Date): Promise<string[]> {
    throw new Error(
      "global cross-tenant expirePastPaymentRequests must not be called from the authed route",
    );
  }

  override async expirePastPaymentRequestsForOrg(
    organizationId: string,
    now: Date,
  ): Promise<string[]> {
    this.forOrgCalls.push({ organizationId, now });
    return Object.entries(this.orgById)
      .filter(([, org]) => org === organizationId)
      .map(([id]) => id);
  }

  override async getPaymentRequest(id: string): Promise<PaymentRequestRow | null> {
    const org = this.orgById[id];
    return org ? fakeRow(id, org) : null;
  }
}

describe("createPaymentRequestsService", () => {
  test("rejects non-USD credit top-up requests before creating provider state", async () => {
    const repository = new GuardedPaymentRequestsRepository();
    const service = createPaymentRequestsService({
      repository,
      adapters: [
        {
          provider: "stripe",
          async createIntent() {
            return { providerIntent: {} };
          },
        },
      ],
    });
    await expect(
      service.create({
        organizationId: "org-1",
        provider: "stripe",
        amountCents: 500,
        currency: "JPY",
        paymentContext: { kind: "any_payer" },
      }),
    ).rejects.toThrow("require USD");
    expect(repository.createCalls).toBe(0);
  });

  test("rejects invalid expiration values before creating a row", async () => {
    for (const expiresInMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE]) {
      const repository = new GuardedPaymentRequestsRepository();
      const service = createPaymentRequestsService({
        repository,
        adapters: [
          {
            provider: "stripe",
            async createIntent() {
              return { providerIntent: {} };
            },
          },
        ],
      });

      await expect(
        service.create({
          organizationId: "org-1",
          provider: "stripe",
          amountCents: 500,
          paymentContext: { kind: "any_payer" },
          expiresInMs,
        }),
      ).rejects.toThrow(/expiresInMs must/);
      expect(repository.createCalls).toBe(0);
    }
  });

  test("passes default and valid expiration dates across the repository boundary", async () => {
    class RecordingRepository extends PaymentRequestsRepository {
      readonly expirations: Date[] = [];
      private row: PaymentRequestRow | null = null;

      override async createPaymentRequest(input: NewPaymentRequest): Promise<PaymentRequestRow> {
        this.expirations.push(input.expiresAt);
        this.row = {
          ...fakeRow("pr-valid-expiry", input.organizationId),
          status: "pending",
          expiresAt: input.expiresAt,
        };
        return this.row;
      }

      override async initializePaymentRequest(): Promise<PaymentRequestRow | null> {
        return this.row && { ...this.row, status: "delivered" };
      }
    }
    const repository = new RecordingRepository();
    const service = createPaymentRequestsService({
      repository,
      adapters: [
        {
          provider: "stripe",
          async createIntent() {
            return { providerIntent: {} };
          },
        },
      ],
    });
    const beforeDefault = Date.now();
    await service.create({
      organizationId: "org-1",
      provider: "stripe",
      amountCents: 500,
      paymentContext: { kind: "any_payer" },
    });
    const afterDefault = Date.now();
    expect(repository.expirations[0].getTime()).toBeGreaterThanOrEqual(beforeDefault + 1_800_000);
    expect(repository.expirations[0].getTime()).toBeLessThanOrEqual(afterDefault + 1_800_000);

    const beforeValid = Date.now();
    await service.create({
      organizationId: "org-1",
      provider: "stripe",
      amountCents: 500,
      paymentContext: { kind: "any_payer" },
      expiresInMs: 60_000,
    });
    const afterValid = Date.now();
    expect(repository.expirations[1].getTime()).toBeGreaterThanOrEqual(beforeValid + 60_000);
    expect(repository.expirations[1].getTime()).toBeLessThanOrEqual(afterValid + 60_000);
  });
  test("rejects providers without a real adapter before creating a row", async () => {
    const repository = new GuardedPaymentRequestsRepository();
    const service = createPaymentRequestsService({
      repository,
      adapters: [],
    });

    await expect(
      service.create({
        organizationId: "org-1",
        provider: "oxapay",
        amountCents: 500,
        currency: "USD",
        paymentContext: { kind: "any_payer" },
      }),
    ).rejects.toThrow("No adapter registered for provider: oxapay");

    expect(repository.createCalls).toBe(0);
  });
});

describe("expirePastForOrg (least-privilege expire, #10117)", () => {
  test("only sweeps the caller's org and never the global sweep", async () => {
    const repository = new ExpireScopingRepository({
      "pr-mine-1": "org-1",
      "pr-mine-2": "org-1",
      "pr-other": "org-2",
    });
    const service = createPaymentRequestsService({ repository, adapters: [] });

    const now = new Date("2026-01-01T00:00:00Z");
    const expired = await service.expirePastForOrg("org-1", now);

    // Only org-1's rows are returned; org-2's row is untouched.
    expect(expired.sort()).toEqual(["pr-mine-1", "pr-mine-2"]);
    expect(repository.forOrgCalls).toEqual([{ organizationId: "org-1", now }]);
  });

  test("expirePast (cron) still uses the global sweep", async () => {
    const repository = new ExpireScopingRepository({});
    const service = createPaymentRequestsService({ repository, adapters: [] });
    // The cron path intentionally calls the global sweep, which this fake throws on.
    await expect(service.expirePast(new Date())).rejects.toThrow(
      "global cross-tenant expirePastPaymentRequests must not be called",
    );
  });
});

/** Returns a stable current row after every simulated compare-and-set miss. */
class CasMissRepository extends PaymentRequestsRepository {
  readonly row: PaymentRequestRow;

  constructor(row: PaymentRequestRow) {
    super();
    this.row = row;
  }

  override async getPaymentRequest(id: string): Promise<PaymentRequestRow | null> {
    return this.row.id === id ? this.row : null;
  }

  override async settlePaymentRequest(): Promise<PaymentRequestRow | null> {
    return null;
  }

  override async failPaymentRequest(): Promise<PaymentRequestRow | null> {
    return null;
  }

  override async initializePaymentRequest(): Promise<PaymentRequestRow | null> {
    return null;
  }
}

describe("compare-and-set replay handling", () => {
  test("returns the existing row for an identical settlement replay", async () => {
    const row = {
      ...fakeRow("pr-settle", "org-1"),
      status: "settled" as const,
      settlementTxRef: "trk-1",
      settledAt: new Date(),
    };
    const service = createPaymentRequestsService({
      repository: new CasMissRepository(row),
      adapters: [],
    });

    await expect(service.markSettled(row.id, "trk-1", {})).resolves.toBe(row);
  });

  test("rejects a different settlement reference after the terminal CAS", async () => {
    const row = {
      ...fakeRow("pr-settle-conflict", "org-1"),
      status: "settled" as const,
      settlementTxRef: "trk-a",
      settledAt: new Date(),
    };
    const service = createPaymentRequestsService({
      repository: new CasMissRepository(row),
      adapters: [],
    });

    await expect(service.markSettled(row.id, "trk-b", {})).rejects.toThrow(
      'already in terminal status "settled"',
    );
  });

  test("returns the existing row for an identical initialization replay", async () => {
    const row = {
      ...fakeRow("pr-delivered", "org-1"),
      status: "delivered" as const,
      hostedUrl: "https://checkout.example.test/session",
      providerIntent: { stripe_session_id: "cs_1" },
      expiresAt: new Date(Date.now() + 60_000),
    };
    const service = createPaymentRequestsService({
      repository: new CasMissRepository(row),
      adapters: [],
    });

    await expect(service.markInitialized(row.id, row.providerIntent, row.hostedUrl)).resolves.toBe(
      row,
    );
  });

  test("rejects a changed initialization after another writer wins", async () => {
    const row = {
      ...fakeRow("pr-delivered-conflict", "org-1"),
      status: "delivered" as const,
      hostedUrl: "https://checkout.example.test/first",
      providerIntent: { stripe_session_id: "cs_first" },
      expiresAt: new Date(Date.now() + 60_000),
    };
    const service = createPaymentRequestsService({
      repository: new CasMissRepository(row),
      adapters: [],
    });

    await expect(
      service.markInitialized(
        row.id,
        { stripe_session_id: "cs_second" },
        "https://checkout.example.test/second",
      ),
    ).rejects.toThrow('state changed concurrently to "delivered"');
  });
});
