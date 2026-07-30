/** Exercises local agent request behavior with deterministic app-core test fixtures. */
import { describe, expect, it, vi } from "vitest";
import {
  createLocalAgentRequestHandler,
  type LocalAgentDispatcher,
  type NormalizedLocalAgentRequest,
  normalizeLocalAgentRequest,
} from "./local-agent-request";

/**
 * Unit tests for the desktop `localAgentRequest` main-process handler (#12355):
 * param normalization/validation and the dispatcher forwarding contract. The
 * dispatcher is a deterministic in-memory fake (no spawned child) — the
 * per-platform NDJSON stdio leg is proven by the desktop capture lane.
 */

describe("normalizeLocalAgentRequest", () => {
  it("normalizes a minimal GET request (defaults method + empty headers)", () => {
    expect(
      normalizeLocalAgentRequest({
        requestId: "request-1",
        path: "/api/health",
      }),
    ).toEqual({
      requestId: "request-1",
      path: "/api/health",
      method: "GET",
      headers: {},
      body: null,
    });
  });

  it("uppercases the method and drops a body on GET/HEAD is rejected loudly", () => {
    expect(
      normalizeLocalAgentRequest({
        requestId: "request-2",
        path: "/api/messaging/send",
        method: "post",
        headers: { "content-type": "application/json" },
        body: '{"text":"hi"}',
      }),
    ).toEqual({
      requestId: "request-2",
      path: "/api/messaging/send",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"text":"hi"}',
    });
  });

  it("throws when path is missing", () => {
    expect(() => normalizeLocalAgentRequest({})).toThrow(
      /requestId must be a non-empty string/,
    );
  });

  it("throws when path is not agent-relative (absolute URL)", () => {
    expect(() =>
      normalizeLocalAgentRequest({
        requestId: "request-3",
        path: "http://127.0.0.1:31337/api/health",
      }),
    ).toThrow(/must be agent-relative/);
  });

  it("throws when a body is sent with GET", () => {
    expect(() =>
      normalizeLocalAgentRequest({
        requestId: "request-4",
        path: "/api/health",
        method: "GET",
        body: "x",
      }),
    ).toThrow(/must not carry a body/);
  });

  it("drops non-string header values and a non-object params throws", () => {
    expect(
      normalizeLocalAgentRequest({
        requestId: "request-5",
        path: "/api/x",
        method: "POST",
        headers: { a: "1", b: 2, c: "3" },
      }).headers,
    ).toEqual({ a: "1", c: "3" });
    expect(() => normalizeLocalAgentRequest(null)).toThrow(
      /params must be an object/,
    );
  });

  it("rejects a missing owner request id", () => {
    expect(() => normalizeLocalAgentRequest({ path: "/api/x" })).toThrow(
      /requestId must be a non-empty string/,
    );
  });
});

describe("createLocalAgentRequestHandler", () => {
  it("forwards the normalized request to the dispatcher and returns its result", async () => {
    const seen: NormalizedLocalAgentRequest[] = [];
    const dispatcher: LocalAgentDispatcher = {
      request: async (req) => {
        seen.push(req);
        return { status: 200, body: '{"ok":true}', headers: { x: "y" } };
      },
      cancel: () => false,
      requestStream: async () => ({ streamId: "unused", status: 200 }),
    };
    const handler = createLocalAgentRequestHandler(dispatcher);

    const result = await handler({
      requestId: "request-6",
      path: "/api/health",
      method: "get",
    });

    expect(result).toEqual({
      status: 200,
      body: '{"ok":true}',
      headers: { x: "y" },
    });
    expect(seen).toEqual([
      {
        requestId: "request-6",
        path: "/api/health",
        method: "GET",
        headers: {},
        body: null,
      },
    ]);
  });

  it("propagates a dispatcher rejection (never fabricates a success response)", async () => {
    const dispatcher: LocalAgentDispatcher = {
      request: vi
        .fn()
        .mockRejectedValue(new Error("child stdio bridge closed")),
      cancel: () => false,
      requestStream: async () => ({ streamId: "unused", status: 200 }),
    };
    const handler = createLocalAgentRequestHandler(dispatcher);

    await expect(
      handler({ requestId: "request-7", path: "/api/health" }),
    ).rejects.toThrow(/child stdio bridge closed/);
  });

  it("rejects a bad path before touching the dispatcher", async () => {
    const request = vi.fn();
    const handler = createLocalAgentRequestHandler({
      request,
      cancel: () => false,
      requestStream: async () => ({ streamId: "unused", status: 200 }),
    });

    await expect(
      handler({ requestId: "request-8", path: "not-relative" } as never),
    ).rejects.toThrow(/must be agent-relative/);
    expect(request).not.toHaveBeenCalled();
  });
});
