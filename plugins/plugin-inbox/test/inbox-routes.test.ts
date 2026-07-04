/**
 * Auth-gate + request-shaping unit tests for the inbox HTTP routes, with the
 * InboxService and queue-operation dispatch mocked out (see the real-runtime
 * suite for end-to-end route coverage). Deterministic — no live model or DB.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/actions/inbox.ts", () => ({
  executeInboxQueueOperation: vi.fn(),
}));

vi.mock("../src/inbox/service.ts", () => ({
  InboxService: class {
    constructor() {
      throw new Error("InboxService should not be constructed");
    }
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
