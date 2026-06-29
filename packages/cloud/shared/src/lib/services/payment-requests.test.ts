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
