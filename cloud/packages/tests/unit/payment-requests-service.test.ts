import { beforeEach, describe, expect, test } from "bun:test";
import type {
  PaymentRequestRow,
  PaymentRequestsRepository,
} from "../../db/repositories/payment-requests";
import {
  createPaymentRequestsService,
  type PaymentProviderAdapter,
} from "../../lib/services/payment-requests";

interface RecordedEvent {
  paymentRequestId: string;
  eventName: string;
  redactedPayload?: unknown;
}

function makeRow(overrides: Partial<PaymentRequestRow> = {}): PaymentRequestRow {
  return {
    id: "pr_test_1",
    organizationId: "org-1",
    agentId: null,
    appId: null,
    provider: "stripe",
    amountCents: 500,
    currency: "USD",
    reason: null,
    paymentContext: { kind: "any_payer" },
    payerIdentityId: null,
    payerUserId: null,
    status: "pending",
    hostedUrl: null,
    callbackUrl: null,
    callbackSecret: null,
    providerIntent: {},
    settledAt: null,
    settlementTxRef: null,
    settlementProof: null,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeFakeRepository(seed?: PaymentRequestRow) {
  const store = new Map<string, PaymentRequestRow>();
  const events: RecordedEvent[] = [];
  if (seed) store.set(seed.id, seed);
  let idCounter = 0;

  const repo: PaymentRequestsRepository = {
    async createPaymentRequest(input: unknown): Promise<PaymentRequestRow> {
      const data = input as Partial<PaymentRequestRow>;
      const id = data.id ?? `pr_test_${++idCounter}`;
      const now = new Date();
      const row: PaymentRequestRow = makeRow({
        ...data,
        id,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
      store.set(id, row);
      return row;
    },
    async getPaymentRequest(id: string): Promise<PaymentRequestRow | null> {
      return store.get(id) ?? null;
    },
    async listPaymentRequests(filter: unknown): Promise<PaymentRequestRow[]> {
      const f = (filter ?? {}) as {
        organizationId?: string;
        status?: PaymentRequestRow["status"];
        provider?: PaymentRequestRow["provider"];
      };
      return Array.from(store.values()).filter((row) => {
        if (f.organizationId && row.organizationId !== f.organizationId) return false;
        if (f.status && row.status !== f.status) return false;
        if (f.provider && row.provider !== f.provider) return false;
        return true;
      });
    },
    async updatePaymentRequestStatus(
      id: string,
      status: PaymentRequestRow["status"] | null,
      patch?: Partial<PaymentRequestRow>,
    ): Promise<PaymentRequestRow | null> {
      const existing = store.get(id);
      if (!existing) return null;
      const next: PaymentRequestRow = {
        ...existing,
        ...(patch ?? {}),
        ...(status ? { status } : {}),
        updatedAt: new Date(),
      };
      store.set(id, next);
      return next;
    },
    async recordPaymentRequestEvent(input: {
      paymentRequestId: string;
      eventName: string;
      redactedPayload?: unknown;
    }): Promise<unknown> {
      events.push(input);
      return input;
    },
    async expirePastPaymentRequests(now: Date): Promise<string[]> {
      const expired: string[] = [];
      for (const [id, row] of store) {
        if (
          row.expiresAt.getTime() <= now.getTime() &&
          (row.status === "pending" || row.status === "delivered")
        ) {
          store.set(id, { ...row, status: "expired", updatedAt: new Date() });
          expired.push(id);
        }
      }
      return expired;
    },
    async findPaymentRequestByProviderIntentKey(): Promise<PaymentRequestRow | null> {
      return null;
    },
  };

  return { repo, store, events };
}

function makeStubAdapter(overrides: Partial<PaymentProviderAdapter> = {}): PaymentProviderAdapter {
  return {
    provider: "stripe",
    async createIntent({ request }) {
      return {
        hostedUrl: `https://stub.invalid/stripe/${request.id}`,
        providerIntent: { stub: true },
      };
    },
    ...overrides,
  };
}

describe("paymentRequestsService", () => {
  let fake: ReturnType<typeof makeFakeRepository>;

  beforeEach(() => {
    fake = makeFakeRepository();
  });

  test("create persists request, calls adapter, records payment.created", async () => {
    const service = createPaymentRequestsService({
      repository: fake.repo,
      adapters: [makeStubAdapter()],
    });

    const result = await service.create({
      organizationId: "org-1",
      provider: "stripe",
      amountCents: 1234,
      paymentContext: { kind: "any_payer" },
    });

    expect(result.paymentRequest.organizationId).toBe("org-1");
    expect(result.paymentRequest.amountCents).toBe(1234);
    expect(result.paymentRequest.currency).toBe("USD");
    expect(result.hostedUrl).toBe(`https://stub.invalid/stripe/${result.paymentRequest.id}`);
    expect(result.paymentRequest.providerIntent).toEqual({ stub: true });

    const created = fake.events.find((e) => e.eventName === "payment.created");
    expect(created).toBeDefined();
    const payload = created?.redactedPayload as Record<string, unknown>;
    expect(payload.paymentRequestId).toBe(result.paymentRequest.id);
    expect(payload.amountCents).toBe(1234);
  });

  test("create rejects invalid amounts and unsupported providers", async () => {
    const service = createPaymentRequestsService({
      repository: fake.repo,
      adapters: [makeStubAdapter()],
    });

    await expect(
      service.create({
        organizationId: "org-1",
        provider: "stripe",
        amountCents: 0,
        paymentContext: { kind: "any_payer" },
      }),
    ).rejects.toThrow(/positive integer/);

    await expect(
      service.create({
        organizationId: "org-1",
        // @ts-expect-error intentionally unsupported provider for test
        provider: "bogus",
        amountCents: 100,
        paymentContext: { kind: "any_payer" },
      }),
    ).rejects.toThrow(/Unsupported provider/);
  });

  test("create requires payerIdentityId for specific_payer context", async () => {
    const service = createPaymentRequestsService({
      repository: fake.repo,
      adapters: [makeStubAdapter()],
    });

    await expect(
      service.create({
        organizationId: "org-1",
        provider: "stripe",
        amountCents: 100,
        // @ts-expect-error missing required payerIdentityId
        paymentContext: { kind: "specific_payer" },
      }),
    ).rejects.toThrow(/payerIdentityId/);
  });

  test("create throws when no adapter is registered for the provider", async () => {
    const service = createPaymentRequestsService({
      repository: fake.repo,
      adapters: [makeStubAdapter({ provider: "oxapay" })],
    });

    await expect(
      service.create({
        organizationId: "org-1",
        provider: "stripe",
        amountCents: 100,
        paymentContext: { kind: "any_payer" },
      }),
    ).rejects.toThrow(/No adapter registered/);
  });

  test("cancel transitions pending → canceled and records event", async () => {
    const service = createPaymentRequestsService({
      repository: fake.repo,
      adapters: [makeStubAdapter()],
    });
    const { paymentRequest } = await service.create({
      organizationId: "org-1",
      provider: "stripe",
      amountCents: 500,
      paymentContext: { kind: "any_payer" },
    });

    const canceled = await service.cancel(paymentRequest.id, "org-1", "user requested");
    expect(canceled.status).toBe("canceled");
    expect(fake.events.some((e) => e.eventName === "payment.canceled")).toBe(true);
  });

  test("cancel rejects if already settled", async () => {
    const seed = makeRow({ id: "pr_seed", status: "settled" });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createPaymentRequestsService({
      repository: fakeSeeded.repo,
      adapters: [makeStubAdapter()],
    });

    await expect(service.cancel("pr_seed", "org-1")).rejects.toThrow(/not cancelable/);
  });

  test("cancel rejects cross-org access", async () => {
    const seed = makeRow({ id: "pr_seed", status: "pending", organizationId: "org-1" });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createPaymentRequestsService({
      repository: fakeSeeded.repo,
      adapters: [makeStubAdapter()],
    });

    await expect(service.cancel("pr_seed", "org-other")).rejects.toThrow(
      /does not belong to organization/,
    );
  });

  test("markSettled writes settlement fields and emits payment.settled", async () => {
    const seed = makeRow({ id: "pr_seed", status: "pending" });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createPaymentRequestsService({
      repository: fakeSeeded.repo,
      adapters: [makeStubAdapter()],
    });

    const settled = await service.markSettled("pr_seed", "tx_abc", { fingerprint: "fp" });
    expect(settled.status).toBe("settled");
    expect(settled.settlementTxRef).toBe("tx_abc");
    expect(settled.settledAt).toBeInstanceOf(Date);
    expect(settled.settlementProof).toEqual({ fingerprint: "fp" });

    const event = fakeSeeded.events.find((e) => e.eventName === "payment.settled");
    expect(event).toBeDefined();
    const payload = event?.redactedPayload as Record<string, unknown>;
    expect(payload.txRef).toBe("tx_abc");
    expect(JSON.stringify(payload)).not.toContain("fingerprint");
  });

  test("markSettled is idempotent for the same settlement tx", async () => {
    const seed = makeRow({
      id: "pr_seed",
      status: "settled",
      settlementTxRef: "tx_abc",
    });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createPaymentRequestsService({
      repository: fakeSeeded.repo,
      adapters: [makeStubAdapter()],
    });

    const settled = await service.markSettled("pr_seed", "tx_abc", {});
    expect(settled.status).toBe("settled");
    expect(settled.settlementTxRef).toBe("tx_abc");
    expect(fakeSeeded.events).toHaveLength(0);
  });

  test("markSettled rejects conflicting terminal states", async () => {
    const seed = makeRow({
      id: "pr_seed",
      status: "settled",
      settlementTxRef: "tx_original",
    });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createPaymentRequestsService({
      repository: fakeSeeded.repo,
      adapters: [makeStubAdapter()],
    });

    await expect(service.markSettled("pr_seed", "tx_other", {})).rejects.toThrow(
      /already in terminal status/,
    );
  });

  test("markInitialized transitions to delivered and records payment.delivered", async () => {
    const seed = makeRow({ id: "pr_seed", status: "pending" });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createPaymentRequestsService({
      repository: fakeSeeded.repo,
      adapters: [makeStubAdapter()],
    });

    const delivered = await service.markInitialized(
      "pr_seed",
      { stripe_session_id: "cs_test" },
      "https://checkout.stripe.com/c/pay/cs_test",
    );

    expect(delivered.status).toBe("delivered");
    expect(delivered.providerIntent).toEqual({ stripe_session_id: "cs_test" });
    expect(delivered.hostedUrl).toBe("https://checkout.stripe.com/c/pay/cs_test");
    expect(fakeSeeded.events.some((e) => e.eventName === "payment.delivered")).toBe(true);
  });

  test("markFailed transitions to failed and records reason", async () => {
    const seed = makeRow({ id: "pr_seed", status: "delivered" });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createPaymentRequestsService({
      repository: fakeSeeded.repo,
      adapters: [makeStubAdapter()],
    });

    const failed = await service.markFailed("pr_seed", "card_declined");
    expect(failed.status).toBe("failed");

    const event = fakeSeeded.events.find((e) => e.eventName === "payment.failed");
    expect(event).toBeDefined();
    expect((event?.redactedPayload as Record<string, unknown>).error).toBe("card_declined");
  });

  test("markFailed is idempotent for already failed requests", async () => {
    const seed = makeRow({ id: "pr_seed", status: "failed" });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createPaymentRequestsService({
      repository: fakeSeeded.repo,
      adapters: [makeStubAdapter()],
    });

    const failed = await service.markFailed("pr_seed", "x");
    expect(failed.status).toBe("failed");
    expect(fakeSeeded.events).toHaveLength(0);
  });

  test("expirePast records payment.expired for each expired id", async () => {
    const past = new Date(Date.now() - 60_000);
    const seed = makeRow({ id: "pr_old", status: "pending", expiresAt: past });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createPaymentRequestsService({
      repository: fakeSeeded.repo,
      adapters: [makeStubAdapter()],
    });

    const expired = await service.expirePast(new Date());
    expect(expired).toEqual(["pr_old"]);
    const event = fakeSeeded.events.find((e) => e.eventName === "payment.expired");
    expect(event?.paymentRequestId).toBe("pr_old");
  });

  test("get returns null for cross-org lookup", async () => {
    const seed = makeRow({ id: "pr_seed", organizationId: "org-1" });
    const fakeSeeded = makeFakeRepository(seed);
    const service = createPaymentRequestsService({
      repository: fakeSeeded.repo,
      adapters: [makeStubAdapter()],
    });

    expect(await service.get("pr_seed", "org-1")).not.toBeNull();
    expect(await service.get("pr_seed", "org-other")).toBeNull();
  });

  test("registering duplicate adapters for the same provider throws", () => {
    expect(() =>
      createPaymentRequestsService({
        repository: fake.repo,
        adapters: [makeStubAdapter(), makeStubAdapter()],
      }),
    ).toThrow(/Duplicate adapter/);
  });
});
