/**
 * Auth-gate + request-shaping unit tests for the inbox HTTP routes, with the
 * InboxService and queue-operation dispatch mocked out (see the real-runtime
 * suite for end-to-end route coverage). Deterministic — no live model or DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeInboxQueueOperation = vi.fn();
const triageMock = vi.fn(async () => ({ triaged: [] }));

vi.mock("../src/actions/inbox.ts", () => ({
  executeInboxQueueOperation,
}));

// The reply/snooze/archive/approve paths never construct InboxService (they go
// through executeInboxQueueOperation), while the triage-write path does. This
// stub records the options the route forwards to `triage` so the tests can
// assert the sanitized `exampleLimit` boundary without a live service.
vi.mock("../src/inbox/service.ts", () => ({
  InboxService: class {
    triage = triageMock;
  },
}));

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    body: undefined,
    params: {},
    query: {},
    headers: {},
    method: "GET",
    path: "/api/lifeops/inbox/triage",
    runtime: { agentId: "agent-inbox-test" },
    inProcess: false,
    isTrustedLocal: false,
    ...overrides,
  };
}

describe("inbox HTTP routes", () => {
  it("rejects authenticated non-local callers before inbox route handling", async () => {
    const { inboxRoutes } = await import("../src/routes/inbox-routes.ts");
    const route = inboxRoutes.find(
      (candidate) =>
        candidate.type === "GET" &&
        candidate.path === "/api/lifeops/inbox/triage",
    );
    expect(route?.routeHandler).toBeDefined();

    const result = await route?.routeHandler?.(makeContext());

    expect(result).toEqual({
      status: 403,
      body: { ok: false, error: "Inbox routes are owner-only" },
    });
  });
});

describe("inbox operation error mapping", () => {
  beforeEach(() => {
    executeInboxQueueOperation.mockReset();
  });

  async function runReply(): Promise<
    { status?: number; body?: { ok?: boolean; error?: string } } | undefined
  > {
    const { inboxRoutes } = await import("../src/routes/inbox-routes.ts");
    const route = inboxRoutes.find(
      (candidate) =>
        candidate.type === "POST" &&
        candidate.path === "/api/lifeops/inbox/:id/reply",
    );
    return route?.routeHandler?.(
      makeContext({
        method: "POST",
        path: "/api/lifeops/inbox/entry-1/reply",
        params: { id: "entry-1" },
        isTrustedLocal: true,
      }),
    ) as Promise<
      { status?: number; body?: { ok?: boolean; error?: string } } | undefined
    >;
  }

  it("maps a not-found entry to 404 (distinct from bad input)", async () => {
    executeInboxQueueOperation.mockRejectedValueOnce(
      new Error("inbox entry entry-1 was not found"),
    );
    const result = await runReply();
    expect(result?.status).toBe(404);
    expect(result?.body?.error).toMatch(/was not found/);
  });

  it("maps a malformed-input failure to 400", async () => {
    executeInboxQueueOperation.mockRejectedValueOnce(
      new Error("reply body is required"),
    );
    const result = await runReply();
    expect(result?.status).toBe(400);
  });

  it("surfaces a genuine operation failure as 500, not 400", async () => {
    // A repository/dispatch failure must reach the caller as a server error,
    // not be masked behind a client 400 the caller cannot act on.
    executeInboxQueueOperation.mockRejectedValueOnce(
      new Error("database connection lost"),
    );
    const result = await runReply();
    expect(result?.status).toBe(500);
    expect(result?.body?.error).toMatch(/database connection lost/);
  });
});

describe("triage write exampleLimit validation", () => {
  beforeEach(() => {
    triageMock.mockClear();
    triageMock.mockResolvedValue({ triaged: [] });
  });

  async function postTriage(
    body: Record<string, unknown>,
  ): Promise<
    { status?: number; body?: { ok?: boolean; error?: string } } | undefined
  > {
    const { inboxRoutes } = await import("../src/routes/inbox-routes.ts");
    const route = inboxRoutes.find(
      (candidate) =>
        candidate.type === "POST" &&
        candidate.path === "/api/lifeops/inbox/triage",
    );
    return route?.routeHandler?.(
      makeContext({
        method: "POST",
        path: "/api/lifeops/inbox/triage",
        isTrustedLocal: true,
        body,
      }),
    ) as Promise<
      { status?: number; body?: { ok?: boolean; error?: string } } | undefined
    >;
  }

  it("rejects a non-finite exampleLimit with a clean 400, never reaching the service", async () => {
    // Regression for #22011: `Infinity` used to flow through the `typeof
    // === number` guard into `getExamples(Infinity)` and emit `LIMIT
    // Infinity`, which Postgres rejects as an unhandled 500.
    const result = await postTriage({
      messages: [],
      exampleLimit: Number.POSITIVE_INFINITY,
    });
    expect(result?.status).toBe(400);
    expect(result?.body?.error).toMatch(/exampleLimit/);
    expect(triageMock).not.toHaveBeenCalled();
  });

  it("rejects a non-positive exampleLimit with a 400", async () => {
    const result = await postTriage({ messages: [], exampleLimit: -5 });
    expect(result?.status).toBe(400);
    expect(triageMock).not.toHaveBeenCalled();
  });

  it("coerces a fractional exampleLimit to an integer before the service call", async () => {
    const result = await postTriage({ messages: [], exampleLimit: 1.5 });
    expect(result?.status).toBe(200);
    expect(triageMock).toHaveBeenCalledTimes(1);
    const opts = triageMock.mock.calls[0]?.[1] as { exampleLimit?: number };
    expect(opts.exampleLimit).toBe(1);
  });

  it("omits exampleLimit entirely when the caller does not supply one", async () => {
    const result = await postTriage({ messages: [] });
    expect(result?.status).toBe(200);
    const opts = triageMock.mock.calls[0]?.[1] as { exampleLimit?: number };
    expect(opts.exampleLimit).toBeUndefined();
  });
});
