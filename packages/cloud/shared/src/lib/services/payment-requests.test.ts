// Exercises payment requests behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import {
  type NewPaymentRequest,
  type NewPaymentRequestEvent,
  type PaymentRequestEventRow,
  type PaymentRequestRow,
  PaymentRequestsRepository,
} from "../../db/repositories/payment-requests";
import { createPaymentRequestsService } from "./payment-requests";

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

/**
 * Records which expire path the service took. The GLOBAL sweep throws so any
 * regression that reintroduces the cross-tenant sweep (#10117) fails loudly.
 */
class ExpireScopingRepository extends PaymentRequestsRepository {
  forOrgCalls: Array<{ organizationId: string; now: Date }> = [];
  events: NewPaymentRequestEvent[] = [];
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

  override async recordPaymentRequestEvent(
    input: NewPaymentRequestEvent,
  ): Promise<PaymentRequestEventRow> {
    this.events.push(input);
    return { id: `evt-${this.events.length}` } as unknown as PaymentRequestEventRow;
  }
}

describe("createPaymentRequestsService", () => {
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
    // An expired event was recorded for each of the caller's rows only.
    expect(repository.events.map((e) => e.paymentRequestId).sort()).toEqual([
      "pr-mine-1",
      "pr-mine-2",
    ]);
    expect(repository.events.every((e) => e.eventName === "payment.expired")).toBe(true);
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

/**
 * In-memory settlement state machine — backs the webhook-replay idempotency
 * tests. Settlement webhooks (Stripe + OxaPay) rely on these exact semantics
 * for "user is credited exactly once" under provider redelivery.
 */
class SettlementRepository extends PaymentRequestsRepository {
  row: PaymentRequestRow;
  events: NewPaymentRequestEvent[] = [];
  updateCalls = 0;

  constructor(row: PaymentRequestRow) {
    super();
    this.row = row;
  }

  override async getPaymentRequest(id: string): Promise<PaymentRequestRow | null> {
    return this.row.id === id ? this.row : null;
  }

  override async updatePaymentRequestStatus(
    id: string,
    status: Parameters<PaymentRequestsRepository["updatePaymentRequestStatus"]>[1],
    patch: Parameters<PaymentRequestsRepository["updatePaymentRequestStatus"]>[2] = {},
  ): Promise<PaymentRequestRow | null> {
    if (this.row.id !== id) return null;
    this.updateCalls += 1;
    this.row = {
      ...this.row,
      ...(status ? { status } : {}),
      ...(patch?.settledAt !== undefined ? { settledAt: patch.settledAt } : {}),
      ...(patch?.settlementTxRef !== undefined ? { settlementTxRef: patch.settlementTxRef } : {}),
      ...(patch?.settlementProof !== undefined ? { settlementProof: patch.settlementProof } : {}),
    };
    return this.row;
  }

  override async recordPaymentRequestEvent(
    input: NewPaymentRequestEvent,
  ): Promise<PaymentRequestEventRow> {
    this.events.push(input);
    return { id: `evt-${this.events.length}` } as unknown as PaymentRequestEventRow;
  }
}

function pendingRow(id: string): PaymentRequestRow {
  return { ...fakeRow(id, "org-1"), status: "pending" };
}

describe("settlement idempotency under webhook replay (#10732)", () => {
  test("markSettled replay with the same txRef is a no-op: one update, one settled event", async () => {
    const repository = new SettlementRepository(pendingRow("pr-settle"));
    const service = createPaymentRequestsService({ repository, adapters: [] });

    const first = await service.markSettled("pr-settle", "trk-1", { provider: "oxapay" });
    expect(first.status).toBe("settled");
    expect(repository.updateCalls).toBe(1);
    expect(repository.events.map((e) => e.eventName)).toEqual(["payment.settled"]);

    // Provider redelivers the identical callback (same txRef): no second
    // update, no second settled event → no double credit downstream.
    const replay = await service.markSettled("pr-settle", "trk-1", { provider: "oxapay" });
    expect(replay.status).toBe("settled");
    expect(replay.settlementTxRef).toBe("trk-1");
    expect(repository.updateCalls).toBe(1);
    expect(repository.events.map((e) => e.eventName)).toEqual(["payment.settled"]);
  });

  test("markSettled with a DIFFERENT txRef after settlement throws (terminal CAS)", async () => {
    const repository = new SettlementRepository(pendingRow("pr-settle-2"));
    const service = createPaymentRequestsService({ repository, adapters: [] });

    await service.markSettled("pr-settle-2", "trk-a", {});
    await expect(service.markSettled("pr-settle-2", "trk-b", {})).rejects.toThrow(
      'already in terminal status "settled"',
    );
    expect(repository.updateCalls).toBe(1);
  });

  test("a late failure callback cannot clobber a settled request", async () => {
    const repository = new SettlementRepository(pendingRow("pr-settle-3"));
    const service = createPaymentRequestsService({ repository, adapters: [] });

    await service.markSettled("pr-settle-3", "trk-c", {});
    await expect(service.markFailed("pr-settle-3", "late failure")).rejects.toThrow(
      'already in terminal status "settled"',
    );
    expect(repository.row.status).toBe("settled");
  });

  test("markFailed replay is a no-op and a late settle after failure throws", async () => {
    const repository = new SettlementRepository(pendingRow("pr-fail"));
    const service = createPaymentRequestsService({ repository, adapters: [] });

    await service.markFailed("pr-fail", "invoice expired");
    expect(repository.updateCalls).toBe(1);

    const replay = await service.markFailed("pr-fail", "invoice expired");
    expect(replay.status).toBe("failed");
    expect(repository.updateCalls).toBe(1);
    expect(repository.events.map((e) => e.eventName)).toEqual(["payment.failed"]);

    await expect(service.markSettled("pr-fail", "trk-x", {})).rejects.toThrow(
      'already in terminal status "failed"',
    );
  });
});
