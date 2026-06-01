import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  type BridgeCredentialAdapter,
  handleBridgeRoutes,
} from "../../src/api/bridge-routes.ts";
import type { RouteContext } from "../../src/api/route-utils.ts";
import { handleCodingAgentRoutes } from "../../src/api/routes.ts";

function fakeRequest(opts: {
  method: string;
  url: string;
  body?: unknown;
  remoteAddress?: string;
}): IncomingMessage {
  // Back the request with a real paused Readable: it buffers the body until a
  // consumer attaches its "data"/"end" listeners, so it is immune to however
  // many microtasks the handler awaits before calling parseBody (e.g. the
  // session-ownership gate). An EventEmitter that emits eagerly would lose
  // those events to that race and hang parseBody.
  const chunks =
    opts.body !== undefined
      ? [Buffer.from(JSON.stringify(opts.body))]
      : [];
  const req = Readable.from(chunks) as unknown as IncomingMessage;
  (req as { method: string }).method = opts.method;
  (req as { url: string }).url = opts.url;
  (req as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: opts.remoteAddress ?? "127.0.0.1",
  };
  return req;
}

function fakeResponse(): {
  res: ServerResponse;
  writes: Buffer[];
  status: () => number;
  body: () => unknown;
} {
  const writes: Buffer[] = [];
  let statusCode = 0;
  const res = {
    writeHead(code: number, _headers?: Record<string, string>) {
      statusCode = code;
    },
    end(chunk?: Buffer | string) {
      if (chunk) {
        writes.push(Buffer.from(typeof chunk === "string" ? chunk : chunk));
      }
      (res as { writableEnded: boolean }).writableEnded = true;
    },
    writableEnded: false,
  } as unknown as ServerResponse;
  return {
    res,
    writes,
    status: () => statusCode,
    body: () => {
      const merged = Buffer.concat(writes).toString("utf8");
      if (!merged) return null;
      try {
        return JSON.parse(merged);
      } catch {
        return merged;
      }
    },
  };
}

function makeAdapter(
  overrides: Partial<BridgeCredentialAdapter> = {},
): BridgeCredentialAdapter {
  return {
    requestCredentials: vi.fn().mockResolvedValue({
      credentialScopeId: "cred_scope_a",
      scopedToken: "deadbeef",
      expiresAt: Date.now() + 60_000,
      sensitiveRequestIds: ["req_1"],
    }),
    tryRetrieveCredential: vi.fn().mockResolvedValue({ status: "pending" }),
    ...overrides,
  };
}

function makeCtx(
  adapter: BridgeCredentialAdapter | null,
  // The POST ownership gate resolves the session via acpService.getSession.
  // Default to an active session so the existing happy-path tests pass; pass
  // `null`/a terminal status to exercise the rejection paths.
  sessionStatus: string | null = "running",
): RouteContext {
  const acpService =
    sessionStatus === null
      ? { getSession: () => null }
      : { getSession: (id: string) => ({ id, status: sessionStatus }) };
  return {
    runtime: {
      getService: (name: string) =>
        name === "SubAgentCredentialBridgeAdapter" ? adapter : null,
    } as unknown as RouteContext["runtime"],
    acpService: acpService as unknown as RouteContext["acpService"],
    workspaceService: null,
  };
}

describe("bridge-routes — credential bridge", () => {
  it("returns 403 from a non-loopback remote", async () => {
    const adapter = makeAdapter();
    const req = fakeRequest({
      method: "POST",
      url: "/api/coding-agents/pty-1-abc/credentials/request",
      body: { credentialKeys: ["OPENAI_API_KEY"] },
      remoteAddress: "10.0.0.5",
    });
    const { res, status, body } = fakeResponse();
    const handled = await handleBridgeRoutes(
      req,
      res,
      "/api/coding-agents/pty-1-abc/credentials/request",
      makeCtx(adapter),
    );
    expect(handled).toBe(true);
    expect(status()).toBe(403);
    expect((body() as { code: string }).code).toBe("loopback_only");
  });

  it("POST /credentials/request declares a scope and returns the token", async () => {
    const adapter = makeAdapter();
    const req = fakeRequest({
      method: "POST",
      url: "/api/coding-agents/pty-1-abc/credentials/request",
      body: { credentialKeys: ["OPENAI_API_KEY"] },
    });
    const { res, status, body } = fakeResponse();
    const handled = await handleBridgeRoutes(
      req,
      res,
      "/api/coding-agents/pty-1-abc/credentials/request",
      makeCtx(adapter),
    );
    expect(handled).toBe(true);
    expect(status()).toBe(200);
    const responseBody = body() as {
      credentialScopeId: string;
      scopedToken: string;
      sensitiveRequestIds: string[];
    };
    expect(responseBody.credentialScopeId).toBe("cred_scope_a");
    expect(responseBody.scopedToken).toBe("deadbeef");
    expect(responseBody.sensitiveRequestIds).toEqual(["req_1"]);
    expect(adapter.requestCredentials).toHaveBeenCalledWith({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY"],
    });
  });

  it("POST rejects empty credentialKeys", async () => {
    const adapter = makeAdapter();
    const req = fakeRequest({
      method: "POST",
      url: "/api/coding-agents/pty-1-abc/credentials/request",
      body: { credentialKeys: [] },
    });
    const { res, status, body } = fakeResponse();
    await handleBridgeRoutes(
      req,
      res,
      "/api/coding-agents/pty-1-abc/credentials/request",
      makeCtx(adapter),
    );
    expect(status()).toBe(400);
    expect((body() as { code: string }).code).toBe("invalid_credential_keys");
  });

  it("POST rejects an unknown sessionId before issuing a request", async () => {
    const adapter = makeAdapter();
    const req = fakeRequest({
      method: "POST",
      url: "/api/coding-agents/not-a-real-session/credentials/request",
      body: { credentialKeys: ["OPENAI_API_KEY"] },
    });
    const { res, status, body } = fakeResponse();
    await handleBridgeRoutes(
      req,
      res,
      "/api/coding-agents/not-a-real-session/credentials/request",
      makeCtx(adapter, null),
    );
    expect(status()).toBe(410);
    expect((body() as { code: string }).code).toBe("session_not_active");
    // The owner-facing approval flow must NOT be triggered for an unowned id.
    expect(adapter.requestCredentials).not.toHaveBeenCalled();
  });

  it("POST rejects a terminal (stopped) session", async () => {
    const adapter = makeAdapter();
    const req = fakeRequest({
      method: "POST",
      url: "/api/coding-agents/pty-1-abc/credentials/request",
      body: { credentialKeys: ["OPENAI_API_KEY"] },
    });
    const { res, status, body } = fakeResponse();
    await handleBridgeRoutes(
      req,
      res,
      "/api/coding-agents/pty-1-abc/credentials/request",
      makeCtx(adapter, "stopped"),
    );
    expect(status()).toBe(410);
    expect((body() as { code: string }).code).toBe("session_not_active");
    expect(adapter.requestCredentials).not.toHaveBeenCalled();
  });

  it("GET /credentials/:key returns the value when adapter resolves ready", async () => {
    const adapter = makeAdapter({
      tryRetrieveCredential: vi
        .fn()
        .mockResolvedValueOnce({ status: "pending" })
        .mockResolvedValue({ status: "ready", value: "sk-test" }),
    });
    const req = fakeRequest({
      method: "GET",
      url: "/api/coding-agents/pty-1-abc/credentials/OPENAI_API_KEY?token=deadbeef",
    });
    const { res, status, body } = fakeResponse();
    const handled = await handleBridgeRoutes(
      req,
      res,
      "/api/coding-agents/pty-1-abc/credentials/OPENAI_API_KEY",
      makeCtx(adapter),
    );
    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect((body() as { value: string }).value).toBe("sk-test");
  });

  it("GET propagates a 410 when scope expired", async () => {
    const adapter = makeAdapter({
      tryRetrieveCredential: vi.fn().mockResolvedValue({ status: "expired" }),
    });
    const req = fakeRequest({
      method: "GET",
      url: "/api/coding-agents/pty-1-abc/credentials/OPENAI_API_KEY?token=deadbeef",
    });
    const { res, status, body } = fakeResponse();
    await handleBridgeRoutes(
      req,
      res,
      "/api/coding-agents/pty-1-abc/credentials/OPENAI_API_KEY",
      makeCtx(adapter),
    );
    expect(status()).toBe(410);
    expect((body() as { code: string }).code).toBe("scope_expired");
  });

  it("GET requires the token query parameter", async () => {
    const adapter = makeAdapter();
    const req = fakeRequest({
      method: "GET",
      url: "/api/coding-agents/pty-1-abc/credentials/OPENAI_API_KEY",
    });
    const { res, status, body } = fakeResponse();
    await handleBridgeRoutes(
      req,
      res,
      "/api/coding-agents/pty-1-abc/credentials/OPENAI_API_KEY",
      makeCtx(adapter),
    );
    expect(status()).toBe(400);
    expect((body() as { code: string }).code).toBe("missing_token");
  });

  it("returns false for unrelated paths", async () => {
    const adapter = makeAdapter();
    const req = fakeRequest({
      method: "GET",
      url: "/api/coding-agents/pty-1-abc/parent-context",
    });
    const { res } = fakeResponse();
    const handled = await handleBridgeRoutes(
      req,
      res,
      "/api/coding-agents/pty-1-abc/parent-context",
      makeCtx(adapter),
    );
    expect(handled).toBe(false);
  });

  it("returns 503 when no adapter is registered", async () => {
    const req = fakeRequest({
      method: "POST",
      url: "/api/coding-agents/pty-1-abc/credentials/request",
      body: { credentialKeys: ["OPENAI_API_KEY"] },
    });
    const { res, status, body } = fakeResponse();
    await handleBridgeRoutes(
      req,
      res,
      "/api/coding-agents/pty-1-abc/credentials/request",
      makeCtx(null),
    );
    expect(status()).toBe(503);
    expect((body() as { code: string }).code).toBe("no_adapter");
  });
});

describe("coding-agent dispatcher — credential bridge", () => {
  it("reaches credential requests through the top-level route dispatcher", async () => {
    const adapter = makeAdapter();
    const req = fakeRequest({
      method: "POST",
      url: "/api/coding-agents/session-1/credentials/request",
    });
    (req as IncomingMessage & { body?: unknown }).body = {
      credentialKeys: ["OPENAI_API_KEY"],
    };
    const { res, status, body } = fakeResponse();

    const handled = await handleCodingAgentRoutes(
      req,
      res,
      "/api/coding-agents/session-1/credentials/request",
      makeCtx(adapter),
    );

    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(body()).toMatchObject({ credentialScopeId: "cred_scope_a" });
    expect(adapter.requestCredentials).toHaveBeenCalledWith({
      childSessionId: "session-1",
      credentialKeys: ["OPENAI_API_KEY"],
    });
  });
});
