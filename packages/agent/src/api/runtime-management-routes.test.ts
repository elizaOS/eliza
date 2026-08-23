/** Claimed single-shell transport tests for Devices & Runtimes operations. */

import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleRuntimeManagementRoutes,
  type RuntimeManagementRouteContext,
  runtimeManagementRouteInternals,
} from "./runtime-management-routes.ts";

type Body = Record<string, unknown>;

function makeContext(method: string, pathname: string, body: Body | null) {
  const req = Readable.from(
    body === null ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as http.IncomingMessage;
  const json = vi.fn();
  const error = vi.fn();
  const broadcastWs = vi.fn();
  const broadcastWsToClientId = vi.fn(
    (_clientId: string, _frame: object): number => 1,
  );
  const ctx: RuntimeManagementRouteContext = {
    req,
    res: {} as http.ServerResponse,
    method,
    pathname,
    json,
    error,
    broadcastWs,
    broadcastWsToClientId,
    callerAuthorization: { ok: true, role: "OWNER" },
  };
  return { ctx, json, error, broadcastWs, broadcastWsToClientId };
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50 && !predicate(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(() => {
  runtimeManagementRouteInternals.claims.clear();
});

describe("POST /api/runtime/manage", () => {
  it.each(["/api/runtime/manage/claim", "/api/runtime/manage/result"])(
    "rejects unauthenticated shell callbacks at %s",
    async (pathname) => {
      const request = makeContext("POST", pathname, {
        requestId: "request-1",
        claimToken: "claim-1",
      });
      request.ctx.callerAuthorization = { ok: false, role: "GUEST" };
      await handleRuntimeManagementRoutes(request.ctx);
      expect(request.error).toHaveBeenCalledWith(
        expect.anything(),
        "Runtime management authentication required.",
        401,
      );
      expect(request.json).not.toHaveBeenCalled();
    },
  );

  it("rejects authenticated non-owner callers before shell delivery", async () => {
    const request = makeContext("POST", "/api/runtime/manage", { op: "list" });
    request.ctx.callerAuthorization = { ok: true, role: "USER" };
    await handleRuntimeManagementRoutes(request.ctx);
    expect(request.error).toHaveBeenCalledWith(
      expect.anything(),
      "Runtime management requires owner authority.",
      403,
    );
    expect(request.broadcastWs).not.toHaveBeenCalled();
    expect(request.broadcastWsToClientId).not.toHaveBeenCalled();
  });

  it("lets exactly one shell claim and resolve an operation", async () => {
    const manage = makeContext("POST", "/api/runtime/manage", {
      op: "inspect_ssh",
      runtimeId: "probe-1",
      target: "user@host",
      sshPort: 22,
    });
    const waiting = handleRuntimeManagementRoutes(manage.ctx);
    await flushUntil(() => manage.broadcastWs.mock.calls.length === 1);
    const frame = manage.broadcastWs.mock.calls[0]?.[0] as {
      requestId: string;
      request: Body;
    };
    expect(frame.request).toEqual(
      expect.objectContaining({ op: "inspect_ssh", sshPort: 22 }),
    );

    const firstClaim = makeContext("POST", "/api/runtime/manage/claim", {
      requestId: frame.requestId,
    });
    await handleRuntimeManagementRoutes(firstClaim.ctx);
    const claimBody = firstClaim.json.mock.calls[0]?.[1] as {
      claimed: boolean;
      claimToken: string;
    };
    expect(claimBody.claimed).toBe(true);

    const secondClaim = makeContext("POST", "/api/runtime/manage/claim", {
      requestId: frame.requestId,
    });
    await handleRuntimeManagementRoutes(secondClaim.ctx);
    expect(secondClaim.json).toHaveBeenCalledWith(expect.anything(), {
      claimed: false,
    });

    const result = makeContext("POST", "/api/runtime/manage/result", {
      requestId: frame.requestId,
      claimToken: claimBody.claimToken,
      ok: true,
      data: { inspection: { fingerprints: ["SHA256:observed"] } },
    });
    await handleRuntimeManagementRoutes(result.ctx);
    await waiting;

    expect(manage.json).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: true, op: "inspect_ssh" }),
    );
  });

  it("rejects secret-bearing payloads before broadcasting", async () => {
    const request = makeContext("POST", "/api/runtime/manage", {
      op: "connect_ssh",
      runtimeId: "vps-1",
      accessToken: "must-not-cross",
    });
    await handleRuntimeManagementRoutes(request.ctx);
    expect(request.error).toHaveBeenCalledWith(
      expect.anything(),
      "Invalid runtime operation or secret-bearing field.",
      400,
    );
    expect(request.broadcastWs).not.toHaveBeenCalled();

    const aliased = makeContext("POST", "/api/runtime/manage", {
      op: "list",
      access_token: "must-not-cross",
    });
    await handleRuntimeManagementRoutes(aliased.ctx);
    expect(aliased.error).toHaveBeenCalledWith(
      expect.anything(),
      "Invalid runtime operation or secret-bearing field.",
      400,
    );
    expect(aliased.broadcastWs).not.toHaveBeenCalled();
  });

  it("targets the renderer that originated an app-chat action", async () => {
    const manage = makeContext("POST", "/api/runtime/manage", {
      op: "list",
      clientId: "origin-renderer",
    });
    const waiting = handleRuntimeManagementRoutes(manage.ctx);
    await flushUntil(
      () => manage.broadcastWsToClientId.mock.calls.length === 1,
    );
    expect(manage.broadcastWs).not.toHaveBeenCalled();
    expect(manage.broadcastWsToClientId.mock.calls[0]?.[0]).toBe(
      "origin-renderer",
    );
    const frame = manage.broadcastWsToClientId.mock.calls[0]?.[1] as {
      requestId: string;
    };
    const claim = makeContext("POST", "/api/runtime/manage/claim", {
      requestId: frame.requestId,
    });
    await handleRuntimeManagementRoutes(claim.ctx);
    const claimBody = claim.json.mock.calls[0]?.[1] as { claimToken: string };
    const result = makeContext("POST", "/api/runtime/manage/result", {
      requestId: frame.requestId,
      claimToken: claimBody.claimToken,
      ok: true,
      data: { runtimes: [] },
    });
    await handleRuntimeManagementRoutes(result.ctx);
    await waiting;
    expect(manage.json).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: true, op: "list" }),
    );
  });

  it("rejects a result without the winning claim token", async () => {
    const result = makeContext("POST", "/api/runtime/manage/result", {
      requestId: "missing",
      claimToken: "wrong",
      ok: true,
    });
    await handleRuntimeManagementRoutes(result.ctx);
    expect(result.error).toHaveBeenCalledWith(
      expect.anything(),
      "Unknown or unclaimed runtime operation.",
      409,
    );
  });

  it("preserves the complete shell failure for the planner", async () => {
    const manage = makeContext("POST", "/api/runtime/manage", {
      op: "inspect_ssh",
      runtimeId: "probe-1",
      target: "user@host",
      sshPort: 22,
    });
    const waiting = handleRuntimeManagementRoutes(manage.ctx);
    await flushUntil(() => manage.broadcastWs.mock.calls.length === 1);
    const frame = manage.broadcastWs.mock.calls[0]?.[0] as {
      requestId: string;
    };
    const claim = makeContext("POST", "/api/runtime/manage/claim", {
      requestId: frame.requestId,
    });
    await handleRuntimeManagementRoutes(claim.ctx);
    const claimBody = claim.json.mock.calls[0]?.[1] as { claimToken: string };
    const completeError = `failure:${"x".repeat(800)}`;
    const result = makeContext("POST", "/api/runtime/manage/result", {
      requestId: frame.requestId,
      claimToken: claimBody.claimToken,
      ok: false,
      error: completeError,
    });
    await handleRuntimeManagementRoutes(result.ctx);
    await waiting;
    expect(manage.json).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ error: completeError }),
    );
  });
});
