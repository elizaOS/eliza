/**
 * Verifies bridge-routes — credential bridge.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  createSensitiveRequestDispatchRegistry,
  type SensitiveRequestDeliveryAdapter,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  createCredentialTunnelService,
  createSubAgentCredentialBridgeAdapter,
} from "../../../../packages/app-core/src/services/credential-tunnel-service.ts";
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
  headers?: Record<string, string>;
}): IncomingMessage {
  // Back the request with a real paused Readable: it buffers the body until a
  // consumer attaches its "data"/"end" listeners, so it is immune to however
  // many microtasks the handler awaits before calling parseBody (e.g. the
  // session-ownership gate). An EventEmitter that emits eagerly would lose
  // those events to that race and hang parseBody.
  const chunks =
    opts.body !== undefined ? [Buffer.from(JSON.stringify(opts.body))] : [];
  const req = Readable.from(chunks) as unknown as IncomingMessage;
  (req as { method: string }).method = opts.method;
  (req as { url: string }).url = opts.url;
  (req as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: opts.remoteAddress ?? "127.0.0.1",
  };
  (req as { headers: Record<string, string> }).headers = {
    host: "localhost:2138",
    ...(opts.headers ?? {}),
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
    statusCode,
    headersSent: false,
    setHeader() {
      return res;
    },
    writeHead(code: number, _headers?: Record<string, string>) {
      statusCode = code;
      res.statusCode = code;
      res.headersSent = true;
    },
    end(chunk?: Buffer | string) {
      if (chunk) {
        writes.push(Buffer.from(typeof chunk === "string" ? chunk : chunk));
      }
      if (statusCode === 0) statusCode = res.statusCode;
      res.headersSent = true;
      (res as { writableEnded: boolean }).writableEnded = true;
    },
    writableEnded: false,
  } as unknown as ServerResponse;
  return {
    res,
    writes,
    status: () => statusCode || res.statusCode,
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
  metadata?: Record<string, unknown>,
): RouteContext {
  const acpService =
    sessionStatus === null
      ? { getSession: () => null }
      : {
          getSession: (id: string) => ({
            id,
            status: sessionStatus,
            metadata,
          }),
        };
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
      origin: undefined,
    });
  });

  it("POST passes session metadata as origin for owner-app credential delivery", async () => {
    const adapter = makeAdapter();
    const req = fakeRequest({
      method: "POST",
      url: "/api/coding-agents/pty-1-abc/credentials/request",
      body: { credentialKeys: ["OPENAI_API_KEY"] },
    });
    const { res, status } = fakeResponse();

    await handleBridgeRoutes(
      req,
      res,
      "/api/coding-agents/pty-1-abc/credentials/request",
      makeCtx(adapter, "running", {
        roomId: "room-owner",
        channelId: "channel-owner",
        source: "owner_app",
        userId: "owner-entity",
      }),
    );

    expect(status()).toBe(200);
    expect(adapter.requestCredentials).toHaveBeenCalledWith({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY"],
      origin: {
        roomId: "room-owner",
        channelId: "channel-owner",
        source: "owner_app",
        ownerEntityId: "owner-entity",
      },
    });
  });

  it("routes request and child retrieval through the real app-core adapter", async () => {
    const tunnel = createCredentialTunnelService();
    const dispatch = createSensitiveRequestDispatchRegistry();
    const deliver = vi.fn(
      async (
        _args: Parameters<SensitiveRequestDeliveryAdapter["deliver"]>[0],
      ) => ({
        delivered: true,
        target: "owner_app_inline" as const,
        formRendered: true,
      }),
    );
    dispatch.register({
      target: "owner_app_inline",
      deliver,
    });
    const adapter = createSubAgentCredentialBridgeAdapter({
      tunnel,
      dispatch,
      runtime: { agentId: "parent-agent" } as never,
    });

    const postReq = fakeRequest({
      method: "POST",
      url: "/api/coding-agents/pty-1-abc/credentials/request",
      body: { credentialKeys: ["OPENAI_API_KEY", "STRIPE_KEY"] },
    });
    const postRes = fakeResponse();

    await handleBridgeRoutes(
      postReq,
      postRes.res,
      "/api/coding-agents/pty-1-abc/credentials/request",
      makeCtx(adapter),
    );

    expect(postRes.status()).toBe(200);
    const scope = postRes.body() as {
      credentialScopeId: string;
      scopedToken: string;
      sensitiveRequestIds: string[];
    };
    expect(scope.credentialScopeId).toMatch(/^cred_scope_/);
    expect(scope.scopedToken).toMatch(/^[0-9a-f]{64}$/);
    expect(scope.sensitiveRequestIds).toHaveLength(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    const dispatchedRequest = deliver.mock.calls[0][0].request as unknown as {
      delivery?: {
        tunnel?: {
          credentialScopeId: string;
          childSessionId: string;
          keys?: readonly string[];
        };
      };
    };
    expect(dispatchedRequest.delivery?.tunnel).toEqual({
      credentialScopeId: scope.credentialScopeId,
      childSessionId: "pty-1-abc",
      keys: ["OPENAI_API_KEY", "STRIPE_KEY"],
    });
    expect(JSON.stringify(dispatchedRequest)).not.toContain(scope.scopedToken);

    await adapter.tunnelCredential({
      childSessionId: "pty-1-abc",
      credentialScopeId: scope.credentialScopeId,
      key: "OPENAI_API_KEY",
      value: "sk-real-route-test",
    });

    const getReq = fakeRequest({
      method: "GET",
      url: `/api/coding-agents/pty-1-abc/credentials/OPENAI_API_KEY?token=${scope.scopedToken}`,
    });
    const getRes = fakeResponse();

    await handleBridgeRoutes(
      getReq,
      getRes.res,
      "/api/coding-agents/pty-1-abc/credentials/OPENAI_API_KEY",
      makeCtx(adapter),
    );

    expect(getRes.status()).toBe(200);
    expect(getRes.body()).toMatchObject({
      key: "OPENAI_API_KEY",
      value: "sk-real-route-test",
    });
    expect(
      tunnel.hasCiphertext(scope.credentialScopeId, "OPENAI_API_KEY"),
    ).toBe(false);

    const replayReq = fakeRequest({
      method: "GET",
      url: `/api/coding-agents/pty-1-abc/credentials/OPENAI_API_KEY?token=${scope.scopedToken}`,
    });
    const replayRes = fakeResponse();

    await handleBridgeRoutes(
      replayReq,
      replayRes.res,
      "/api/coding-agents/pty-1-abc/credentials/OPENAI_API_KEY",
      makeCtx(adapter),
    );

    expect(replayRes.status()).toBe(403);
    expect(replayRes.body()).toEqual({
      error: "already_redeemed",
      code: "already_redeemed",
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

  it("GET preserves the adapter rejection reason as the response code", async () => {
    const adapter = makeAdapter({
      tryRetrieveCredential: vi
        .fn()
        .mockResolvedValue({ status: "rejected", reason: "already_redeemed" }),
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

    expect(status()).toBe(403);
    expect(body()).toEqual({
      error: "already_redeemed",
      code: "already_redeemed",
    });
  });

  it("GET collapses a raw (non-enum) rejection reason to a stable code", async () => {
    const adapter = makeAdapter({
      tryRetrieveCredential: vi.fn().mockResolvedValue({
        status: "rejected",
        reason: "Cannot read properties of undefined (reading 'x')",
      }),
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

    expect(status()).toBe(403);
    // Raw error text stays human-readable in `error` but must not leak into the
    // machine-readable `code`.
    expect(body()).toEqual({
      error: "Cannot read properties of undefined (reading 'x')",
      code: "rejected",
    });
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

  it("GET rejects an unknown sessionId before redeeming a credential", async () => {
    const adapter = makeAdapter();
    const req = fakeRequest({
      method: "GET",
      url: "/api/coding-agents/not-a-real-session/credentials/OPENAI_API_KEY?token=deadbeef",
    });
    const { res, status, body } = fakeResponse();
    await handleBridgeRoutes(
      req,
      res,
      "/api/coding-agents/not-a-real-session/credentials/OPENAI_API_KEY",
      makeCtx(adapter, null),
    );
    expect(status()).toBe(410);
    expect((body() as { code: string }).code).toBe("session_not_active");
    // The adapter must not be touched for an unowned session id.
    expect(adapter.tryRetrieveCredential).not.toHaveBeenCalled();
  });

  it("GET rejects a terminal (stopped) session", async () => {
    const adapter = makeAdapter();
    const req = fakeRequest({
      method: "GET",
      url: "/api/coding-agents/pty-1-abc/credentials/OPENAI_API_KEY?token=deadbeef",
    });
    const { res, status, body } = fakeResponse();
    await handleBridgeRoutes(
      req,
      res,
      "/api/coding-agents/pty-1-abc/credentials/OPENAI_API_KEY",
      makeCtx(adapter, "stopped"),
    );
    expect(status()).toBe(410);
    expect((body() as { code: string }).code).toBe("session_not_active");
    expect(adapter.tryRetrieveCredential).not.toHaveBeenCalled();
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

/**
 * A faithful one-shot adapter backed by an in-memory store, mirroring the
 * production `createSubAgentCredentialBridgeAdapter` semantics (POST mints a
 * scope; a staged value is delivered exactly once; replays are rejected). The
 * real engine + the real adapter are unit-tested in app-core
 * (`credential-tunnel-service.test.ts`); this exercises the ROUTE wiring with
 * realistic round-trip behavior without crossing the plugin → app-core layer
 * boundary.
 */
function makeOneShotAdapter(): BridgeCredentialAdapter & {
  stage: (key: string, value: string) => void;
} {
  const declared = new Set<string>();
  const staged = new Map<string, string>();
  const redeemed = new Set<string>();
  return {
    async requestCredentials({ credentialKeys }) {
      for (const k of credentialKeys) declared.add(k);
      return {
        credentialScopeId: "cred_scope_real",
        scopedToken: "a".repeat(64),
        expiresAt: Date.now() + 60_000,
        sensitiveRequestIds: ["sreq_real"],
      };
    },
    async tryRetrieveCredential({ key }) {
      if (redeemed.has(key))
        return { status: "rejected", reason: "already_redeemed" };
      if (!declared.has(key))
        return { status: "rejected", reason: "key_not_in_scope" };
      const value = staged.get(key);
      if (value === undefined) return { status: "pending" };
      redeemed.add(key);
      staged.delete(key);
      return { status: "ready", value };
    },
    stage(key, value) {
      staged.set(key, value);
    },
  };
}

function makeCtxWithOrigin(adapter: BridgeCredentialAdapter): {
  ctx: RouteContext;
  sent: Array<{ text?: string }>;
} {
  const sent: Array<{ text?: string }> = [];
  const ctx = {
    runtime: {
      getService: (name: string) =>
        name === "SubAgentCredentialBridgeAdapter" ? adapter : null,
      getSetting: () => undefined,
      // emitCredentialPrompt / emitCredentialResolved post here.
      sendMessageToTarget: async (
        _target: unknown,
        content: { text?: string },
      ) => {
        sent.push(content);
      },
    } as unknown as RouteContext["runtime"],
    acpService: {
      getSession: (id: string) => ({
        id,
        status: "running",
        name: "build-feature",
        metadata: {
          roomId: "11111111-1111-1111-1111-111111111111",
          source: "app",
        },
      }),
    } as unknown as RouteContext["acpService"],
    workspaceService: null,
  };
  return { ctx, sent };
}

describe("bridge-routes — real one-shot round-trip", () => {
  it("POST mints a scope, GET long-poll returns the staged value and posts the resolved follow-up", async () => {
    const adapter = makeOneShotAdapter();
    const { ctx, sent } = makeCtxWithOrigin(adapter);

    // POST: mint a scope (no 503 — a real adapter is registered).
    const postReq = fakeRequest({
      method: "POST",
      url: "/api/coding-agents/pty-1-abc/credentials/request",
      body: { credentialKeys: ["OPENAI_API_KEY"] },
    });
    const post = fakeResponse();
    await handleBridgeRoutes(
      postReq,
      post.res,
      "/api/coding-agents/pty-1-abc/credentials/request",
      ctx,
    );
    expect(post.status()).toBe(200);
    expect((post.body() as { scopedToken: string }).scopedToken).toBe(
      "a".repeat(64),
    );
    // The origin-thread prompt was posted (AC1) without leaking the token.
    expect(sent.length).toBe(1);
    expect(sent[0].text ?? "").not.toContain("a".repeat(64));

    // Owner submits → value is staged (simulating tunnelCredential).
    adapter.stage("OPENAI_API_KEY", "sk-from-owner");

    // GET: long-poll redeems the value and posts the resolved follow-up.
    const getReq = fakeRequest({
      method: "GET",
      url: `/api/coding-agents/pty-1-abc/credentials/OPENAI_API_KEY?token=${"a".repeat(64)}`,
    });
    const get = fakeResponse();
    await handleBridgeRoutes(
      getReq,
      get.res,
      "/api/coding-agents/pty-1-abc/credentials/OPENAI_API_KEY",
      ctx,
    );
    expect(get.status()).toBe(200);
    expect((get.body() as { value: string }).value).toBe("sk-from-owner");
    // emitCredentialResolved fired into the origin thread.
    expect(sent.some((m) => (m.text ?? "").includes("received"))).toBe(true);
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
      origin: undefined,
    });
  });
});
