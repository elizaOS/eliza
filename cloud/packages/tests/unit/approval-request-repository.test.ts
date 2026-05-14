import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const APPR_ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APPR_ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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
    id: APPR_ID_A,
    organization_id: ORG_ID,
    agent_id: null,
    user_id: null,
    challenge_kind: "login",
    challenge_payload: { message: "Sign in" },
    expected_signer_identity_id: null,
    status: "pending",
    signature_text: null,
    signed_at: null,
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
    approval_request_id: APPR_ID_A,
    event_name: "approval.created",
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
  const insertChain = (table: unknown) => ({
    values: (payload: unknown) => ({
      returning: () => {
        stub.calls.push({ op: "insert", table: tableName(table), payload, returning: true });
        return Promise.resolve(stub.insertRows);
      },
    }),
  });

  const buildSelectChain = () => {
    const captured: CapturedCall = { op: "select" };
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
        Object.defineProperties(chained, {
          then: {
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
      `../../../packages/db/repositories/approval-requests.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  return mod.approvalRequestsRepository as {
    createApprovalRequest: (input: unknown) => Promise<unknown>;
    getApprovalRequest: (id: string) => Promise<unknown>;
    listApprovalRequests: (filter: unknown) => Promise<unknown>;
    setApprovalRequestStatus: (
      id: string,
      status: string | null,
      patch?: unknown,
    ) => Promise<unknown>;
    recordApprovalRequestEvent: (input: unknown) => Promise<unknown>;
    expirePastApprovalRequests: (now: Date) => Promise<string[]>;
  };
}

describe("approval requests repository", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("createApprovalRequest inserts and returns the new row", async () => {
    const stub: DbStub = {
      calls: [],
      selectRows: [],
      insertRows: [makeRow()],
      updateRows: [],
    };
    installDbMock(stub);
    const repo = await loadRepository();

    const result = await repo.createApprovalRequest({
      organizationId: ORG_ID,
      challengeKind: "login",
      challengePayload: { message: "Sign in" },
      expiresAt: FUTURE,
    });

    expect(result).toMatchObject({ id: APPR_ID_A, organizationId: ORG_ID });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      op: "insert",
      table: "approval_requests",
      returning: true,
    });
    expect(stub.calls[0].payload).toMatchObject({
      organization_id: ORG_ID,
      challenge_kind: "login",
      expires_at: FUTURE,
    });
  });

  test("getApprovalRequest returns null when no row matches", async () => {
    const stub: DbStub = { calls: [], selectRows: [], insertRows: [], updateRows: [] };
    installDbMock(stub);
    const repo = await loadRepository();

    const result = await repo.getApprovalRequest(APPR_ID_A);

    expect(result).toBeNull();
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({ op: "select", table: "approval_requests", limit: 1 });
  });

  test("getApprovalRequest returns the row when one is found", async () => {
    const stub: DbStub = { calls: [], selectRows: [makeRow()], insertRows: [], updateRows: [] };
    installDbMock(stub);
    const repo = await loadRepository();

    const result = await repo.getApprovalRequest(APPR_ID_A);

    expect(result).toMatchObject({ id: APPR_ID_A, organizationId: ORG_ID });
  });

  test("listApprovalRequests applies filters, ordering, limit, offset", async () => {
    const stub: DbStub = {
      calls: [],
      selectRows: [makeRow(), makeRow({ id: APPR_ID_B })],
      insertRows: [],
      updateRows: [],
    };
    installDbMock(stub);
    const repo = await loadRepository();

    const result = (await repo.listApprovalRequests({
      organizationId: ORG_ID,
      status: "pending",
      challengeKind: "login",
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
      table: "approval_requests",
      limit: 25,
      offset: 50,
    });
    expect(call?.where).toBeDefined();
    expect(call?.orderBy).toBeDefined();
  });

  test("listApprovalRequests applies default limit and offset when omitted", async () => {
    const stub: DbStub = { calls: [], selectRows: [], insertRows: [], updateRows: [] };
    installDbMock(stub);
    const repo = await loadRepository();

    await repo.listApprovalRequests({ organizationId: ORG_ID });

    expect(stub.calls[0]).toMatchObject({ limit: 100, offset: 0 });
  });

  test("setApprovalRequestStatus updates status + patch and returns the row", async () => {
    const stub: DbStub = {
      calls: [],
      selectRows: [],
      insertRows: [],
      updateRows: [makeRow({ status: "approved", signed_at: NOW })],
    };
    installDbMock(stub);
    const repo = await loadRepository();

    const result = await repo.setApprovalRequestStatus(APPR_ID_A, "approved", {
      signedAt: NOW,
      signatureText: "0xdeadbeef",
    });

    expect(result).toMatchObject({ status: "approved" });
    expect(stub.calls).toHaveLength(1);
    const set = stub.calls[0].set as Record<string, unknown>;
    expect(set.status).toBe("approved");
    expect(set.signature_text).toBe("0xdeadbeef");
    expect(set.updated_at).toBeInstanceOf(Date);
  });

  test("setApprovalRequestStatus returns null when no row matches", async () => {
    const stub: DbStub = { calls: [], selectRows: [], insertRows: [], updateRows: [] };
    installDbMock(stub);
    const repo = await loadRepository();

    const result = await repo.setApprovalRequestStatus(APPR_ID_A, "denied");

    expect(result).toBeNull();
  });

  test("recordApprovalRequestEvent inserts into approval_request_events", async () => {
    const stub: DbStub = {
      calls: [],
      selectRows: [],
      insertRows: [makeEventRow()],
      updateRows: [],
    };
    installDbMock(stub);
    const repo = await loadRepository();

    const result = await repo.recordApprovalRequestEvent({
      approvalRequestId: APPR_ID_A,
      eventName: "approval.created",
      redactedPayload: { challengeKind: "login" },
    });

    expect(result).toMatchObject({ id: EVENT_ID, event_name: "approval.created" });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      op: "insert",
      table: "approval_request_events",
      returning: true,
    });
  });

  test("expirePastApprovalRequests transitions overdue rows to expired and returns ids", async () => {
    const stub: DbStub = {
      calls: [],
      selectRows: [],
      insertRows: [],
      updateRows: [{ id: APPR_ID_A }, { id: APPR_ID_B }],
    };
    installDbMock(stub);
    const repo = await loadRepository();

    const ids = await repo.expirePastApprovalRequests(NOW);

    expect(ids).toEqual([APPR_ID_A, APPR_ID_B]);
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    expect(call.op).toBe("update");
    expect(call.table).toBe("approval_requests");
    const set = call.set as Record<string, unknown>;
    expect(set.status).toBe("expired");
    expect(set.updated_at).toBe(NOW);
  });
});
