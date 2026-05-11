import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PR_ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PR_ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-05-11T00:00:00.000Z");
const FUTURE = new Date("2026-05-11T01:00:00.000Z");

interface CapturedCall {
  op: string;
  payload?: unknown;
  table?: string;
  where?: unknown;
  set?: unknown;
  orderBy?: unknown;
  limit?: number;
  offset?: number;
  returning?: boolean;
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PR_ID_A,
    organization_id: ORG_ID,
    agent_id: null,
    app_id: null,
    provider: "stripe",
    amount_cents: 1000n,
    currency: "usd",
    reason: null,
    payment_context: { kind: "any_payer" },
    payer_identity_id: null,
    payer_user_id: null,
    status: "pending",
    hosted_url: null,
    callback_url: null,
    callback_secret: null,
    provider_intent: { stripe_session_id: "cs_test_123" },
    settled_at: null,
    settlement_tx_ref: null,
    settlement_proof: null,
    expires_at: FUTURE,
    created_at: NOW,
    updated_at: NOW,
    metadata: {},
    ...overrides,
  };
}

function makeEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    payment_request_id: PR_ID_A,
    event_name: "payment.created",
    redacted_payload: {},
    occurred_at: NOW,
    ...overrides,
  };
}

interface DbStub {
  calls: CapturedCall[];
  selectRows: unknown[];
  insertRows: unknown[];
  updateRows: unknown[];
}

function installDbMock(stub: DbStub): void {
  // The repository imports `dbWrite` from `@/db/client` and aliases it as `db`.
  // Provide a chainable Drizzle-shaped stub that records the calls so we can
  // assert that the repository is shaping queries correctly.
  const insertChain = (table: { _: { name?: string } | undefined } | unknown) => ({
    values: (payload: unknown) => ({
      returning: () => {
        stub.calls.push({ op: "insert", table: tableName(table), payload, returning: true });
        return Promise.resolve(stub.insertRows);
      },
    }),
  });

  const buildSelectChain = () => {
    let captured: CapturedCall = { op: "select" };
    const chain = {
      from(table: unknown) {
        captured.table = tableName(table);
        return chain;
      },
      where(predicate: unknown) {
        captured.where = predicate;
        return chain;
      },
      orderBy(order: unknown) {
        captured.orderBy = order;
        return chain;
      },
      offset(o: number) {
        captured.offset = o;
        stub.calls.push(captured);
        return Promise.resolve(stub.selectRows);
      },
      limit(l: number) {
        captured.limit = l;
        const promise = Promise.resolve(stub.selectRows);
        let recorded = false;
        const record = () => {
          if (recorded) return;
          stub.calls.push(captured);
          recorded = true;
        };
        const chained = {
          offset(o: number) {
            captured.limit = l;
            captured.offset = o;
            record();
            return Promise.resolve(stub.selectRows);
          },
        };
        const thenKey = "then";
        Object.defineProperties(chained, {
          [thenKey]: {
            value: (
              onFulfilled?: Parameters<typeof promise.then>[0],
              onRejected?: Parameters<typeof promise.then>[1],
            ) => {
              record();
              return promise.then(onFulfilled, onRejected);
            },
          },
          catch: { value: promise.catch.bind(promise) },
          finally: { value: promise.finally.bind(promise) },
        });
        return chained;
      },
    };
    return chain;
  };

  const updateChain = (table: unknown) => ({
    set(values: unknown) {
      const captured: CapturedCall = { op: "update", table: tableName(table), set: values };
      return {
        where(predicate: unknown) {
          captured.where = predicate;
          return {
            returning(projection?: unknown) {
              captured.returning = true;
              if (projection !== undefined) {
                (captured as CapturedCall & { projection?: unknown }).projection = projection;
              }
              stub.calls.push(captured);
              return Promise.resolve(stub.updateRows);
            },
          };
        },
      };
    },
  });

  function tableName(table: unknown): string {
    if (!table || typeof table !== "object") return "unknown";
    const sym = Object.getOwnPropertySymbols(table).find((s) => s.description === "drizzle:Name");
    if (sym) {
      const value = (table as Record<symbol, unknown>)[sym];
      if (typeof value === "string") return value;
    }
    return "unknown";
  }

  const dbStub = {
    insert: (table: unknown) => insertChain(table),
    select: () => buildSelectChain(),
    update: (table: unknown) => updateChain(table),
  };

  mock.module("@/db/client", () => ({
    dbWrite: dbStub,
    dbRead: dbStub,
    db: dbStub,
  }));
}

async function loadRepository() {
  const mod = await import(
    new URL(
      `../../../packages/db/repositories/payment-requests.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  return mod.paymentRequestsRepository as {
    createPaymentRequest: (input: unknown) => Promise<unknown>;
    getPaymentRequest: (id: string) => Promise<unknown>;
    listPaymentRequests: (filter: unknown) => Promise<unknown>;
    updatePaymentRequestStatus: (
      id: string,
      status: string | null,
      patch?: unknown,
    ) => Promise<unknown>;
    recordPaymentRequestEvent: (input: unknown) => Promise<unknown>;
    expirePastPaymentRequests: (now: Date) => Promise<string[]>;
    findPaymentRequestByProviderIntentKey: (key: string, value: string) => Promise<unknown>;
  };
}

describe("payment requests repository", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("createPaymentRequest inserts and returns the new row", async () => {
    const stub: DbStub = {
      calls: [],
      selectRows: [],
      insertRows: [makeRow()],
      updateRows: [],
    };
    installDbMock(stub);
    const repo = await loadRepository();

    const result = await repo.createPaymentRequest({
      organizationId: ORG_ID,
      provider: "stripe",
      amountCents: 1000,
      currency: "usd",
      paymentContext: { kind: "any_payer" },
      expiresAt: FUTURE,
    });

    expect(result).toMatchObject({ id: PR_ID_A, organizationId: ORG_ID, amountCents: 1000 });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      op: "insert",
      table: "payment_requests",
      returning: true,
    });
    expect(stub.calls[0].payload).toMatchObject({
      organization_id: ORG_ID,
      amount_cents: 1000n,
      expires_at: FUTURE,
    });
  });

  test("getPaymentRequest returns null when no row matches", async () => {
    const stub: DbStub = { calls: [], selectRows: [], insertRows: [], updateRows: [] };
    installDbMock(stub);
    const repo = await loadRepository();

    const result = await repo.getPaymentRequest(PR_ID_A);

    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({ op: "select", table: "payment_requests", limit: 1 });
  });

  test("getPaymentRequest returns the row when one is found", async () => {
    const stub: DbStub = {
      calls: [],
      selectRows: [makeRow()],
      insertRows: [],
      updateRows: [],
    };
    installDbMock(stub);
    const repo = await loadRepository();

    const result = await repo.getPaymentRequest(PR_ID_A);

    expect(result).toMatchObject({ id: PR_ID_A, organizationId: ORG_ID });
  });

  test("listPaymentRequests applies filters, ordering, limit, and offset", async () => {
    const stub: DbStub = {
      calls: [],
      selectRows: [makeRow(), makeRow({ id: PR_ID_B })],
      insertRows: [],
      updateRows: [],
    };
    installDbMock(stub);
    const repo = await loadRepository();

    const result = (await repo.listPaymentRequests({
      organizationId: ORG_ID,
      status: "pending",
      provider: "stripe",
      agentId: "00000000-0000-4000-8000-000000000001",
      since: new Date("2026-05-01T00:00:00.000Z"),
      until: new Date("2026-05-31T23:59:59.000Z"),
      limit: 25,
      offset: 50,
    })) as unknown[];

    expect(result).toHaveLength(2);
    const call = stub.calls.at(-1);
    expect(call).toMatchObject({
      op: "select",
      table: "payment_requests",
      limit: 25,
      offset: 50,
    });
    expect(call?.where).toBeDefined();
    expect(call?.orderBy).toBeDefined();
  });

  test("listPaymentRequests applies default limit and offset when omitted", async () => {
    const stub: DbStub = {
      calls: [],
      selectRows: [],
      insertRows: [],
      updateRows: [],
    };
    installDbMock(stub);
    const repo = await loadRepository();

    await repo.listPaymentRequests({ organizationId: ORG_ID });

    expect(stub.calls[0]).toMatchObject({ limit: 100, offset: 0 });
  });

  test("updatePaymentRequestStatus updates status + patch and returns the row", async () => {
    const stub: DbStub = {
      calls: [],
      selectRows: [],
      insertRows: [],
      updateRows: [makeRow({ status: "settled", settled_at: NOW })],
    };
    installDbMock(stub);
    const repo = await loadRepository();

    const result = await repo.updatePaymentRequestStatus(PR_ID_A, "settled", {
      settledAt: NOW,
      settlementTxRef: "tx_abc",
    });

    expect(result).toMatchObject({ status: "settled" });
    expect(stub.calls).toHaveLength(1);
    const set = stub.calls[0].set as Record<string, unknown>;
    expect(set.status).toBe("settled");
    expect(set.settlement_tx_ref).toBe("tx_abc");
    expect(set.updated_at).toBeInstanceOf(Date);
  });

  test("updatePaymentRequestStatus returns null when no row matches", async () => {
    const stub: DbStub = {
      calls: [],
      selectRows: [],
      insertRows: [],
      updateRows: [],
    };
    installDbMock(stub);
    const repo = await loadRepository();

    const result = await repo.updatePaymentRequestStatus(PR_ID_A, "failed");

    expect(result).toBeNull();
  });

  test("recordPaymentRequestEvent inserts into payment_request_events", async () => {
    const stub: DbStub = {
      calls: [],
      selectRows: [],
      insertRows: [makeEventRow()],
      updateRows: [],
    };
    installDbMock(stub);
    const repo = await loadRepository();

    const result = await repo.recordPaymentRequestEvent({
      paymentRequestId: PR_ID_A,
      eventName: "payment.created",
      redactedPayload: { provider: "stripe" },
    });

    expect(result).toMatchObject({ id: EVENT_ID, event_name: "payment.created" });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      op: "insert",
      table: "payment_request_events",
      returning: true,
    });
  });

  test("expirePastPaymentRequests transitions overdue rows to expired and returns ids", async () => {
    const stub: DbStub = {
      calls: [],
      selectRows: [],
      insertRows: [],
      updateRows: [{ id: PR_ID_A }, { id: PR_ID_B }],
    };
    installDbMock(stub);
    const repo = await loadRepository();

    const ids = await repo.expirePastPaymentRequests(NOW);

    expect(ids).toEqual([PR_ID_A, PR_ID_B]);
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    expect(call.op).toBe("update");
    expect(call.table).toBe("payment_requests");
    const set = call.set as Record<string, unknown>;
    expect(set.status).toBe("expired");
    expect(set.updated_at).toBe(NOW);
  });

  test("findPaymentRequestByProviderIntentKey returns the matching row", async () => {
    const stub: DbStub = {
      calls: [],
      selectRows: [makeRow()],
      insertRows: [],
      updateRows: [],
    };
    installDbMock(stub);
    const repo = await loadRepository();

    const result = await repo.findPaymentRequestByProviderIntentKey(
      "stripe_session_id",
      "cs_test_123",
    );

    expect(result).toMatchObject({ id: PR_ID_A });
    expect(stub.calls[0]).toMatchObject({
      op: "select",
      table: "payment_requests",
      limit: 1,
    });
    expect(stub.calls[0].where).toBeDefined();
  });

  test("findPaymentRequestByProviderIntentKey returns null when no match", async () => {
    const stub: DbStub = {
      calls: [],
      selectRows: [],
      insertRows: [],
      updateRows: [],
    };
    installDbMock(stub);
    const repo = await loadRepository();

    const result = await repo.findPaymentRequestByProviderIntentKey("x402_request_id", "missing");

    expect(result).toBeNull();
  });
});
