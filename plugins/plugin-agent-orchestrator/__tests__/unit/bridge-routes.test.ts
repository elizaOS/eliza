import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  type BridgeCredentialAdapter,
  handleBridgeRoutes,
} from "../../src/api/bridge-routes.ts";
import type { RouteContext } from "../../src/api/route-utils.ts";

function fakeRequest(opts: {
  method: string;
  url: string;
  body?: unknown;
  remoteAddress?: string;
}): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage;
  (emitter as { method: string }).method = opts.method;
  (emitter as { url: string }).url = opts.url;
  (emitter as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: opts.remoteAddress ?? "127.0.0.1",
  };
  // Drive the data/end pump on next tick so parseBody sees them.
  queueMicrotask(() => {
    if (opts.body !== undefined) {
      emitter.emit("data", Buffer.from(JSON.stringify(opts.body)));
    }
    emitter.emit("end");
  });
  return emitter;
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

function makeCtx(adapter: BridgeCredentialAdapter | null): RouteContext {
  return {
    runtime: {
      getService: (name: string) =>
        name === "SubAgentCredentialBridgeAdapter" ? adapter : null,
    } as unknown as RouteContext["runtime"],
    acpService: null,
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
