import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { BridgeCredentialAdapter } from "../../src/api/bridge-routes.ts";
import type { RouteContext } from "../../src/api/route-utils.ts";
import { handleCodingAgentRoutes } from "../../src/api/routes.ts";

// Regression guard for the credential-bridge dispatcher wiring.
//
// `handleBridgeRoutes` is exercised directly in `bridge-routes.test.ts`. This
// suite instead drives the top-level `handleCodingAgentRoutes` dispatcher to
// prove the bridge is actually *mounted* there — if the dispatch call is ever
// removed, a `/credentials/*` request falls through every handler and the
// dispatcher returns `false`, which these assertions catch.

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
  // Emit body on a macrotask (not a microtask): the dispatcher awaits the
  // orchestrator and parent-context handlers before reaching the bridge, so a
  // microtask would fire `data`/`end` before `parseBody` attaches its listeners
  // and the body would be lost. A `setTimeout(0)` lands after those awaits.
  setTimeout(() => {
    if (opts.body !== undefined) {
      emitter.emit("data", Buffer.from(JSON.stringify(opts.body)));
    }
    emitter.emit("end");
  }, 0);
  return emitter;
}

function fakeResponse(): {
  res: ServerResponse;
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

describe("routes dispatcher — credential bridge is mounted", () => {
  const path = "/api/coding-agents/pty-1-abc/credentials/request";

  it("dispatches POST /credentials/request into the bridge (200 with adapter)", async () => {
    const adapter: BridgeCredentialAdapter = {
      requestCredentials: vi.fn().mockResolvedValue({
        credentialScopeId: "cred_scope_a",
        scopedToken: "deadbeef",
        expiresAt: 1,
        sensitiveRequestIds: ["req_1"],
      }),
      tryRetrieveCredential: vi.fn().mockResolvedValue({ status: "pending" }),
    };
    const req = fakeRequest({
      method: "POST",
      url: path,
      body: { credentialKeys: ["OPENAI_API_KEY"] },
    });
    const { res, status, body } = fakeResponse();

    const handled = await handleCodingAgentRoutes(
      req,
      res,
      path,
      makeCtx(adapter),
    );

    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect((body() as { scopedToken: string }).scopedToken).toBe("deadbeef");
    expect(adapter.requestCredentials).toHaveBeenCalledWith({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY"],
    });
  });

  it("fails closed with 503 when no adapter — proving it is mounted, not falling through to a 404", async () => {
    const req = fakeRequest({
      method: "POST",
      url: path,
      body: { credentialKeys: ["OPENAI_API_KEY"] },
    });
    const { res, status, body } = fakeResponse();

    const handled = await handleCodingAgentRoutes(
      req,
      res,
      path,
      makeCtx(null),
    );

    // `handled === true` is the key regression signal: an unmounted bridge
    // would let this path fall through all handlers and return false.
    expect(handled).toBe(true);
    expect(status()).toBe(503);
    expect((body() as { code: string }).code).toBe("no_adapter");
  });
});
