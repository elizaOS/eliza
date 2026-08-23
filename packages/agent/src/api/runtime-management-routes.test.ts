/** Claimed single-shell transport tests for Devices & Runtimes operations. */

import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RuntimeManagementProposal,
  RuntimeManagementProposalStore,
} from "./runtime-management-proposal-store.ts";
import {
  handleRuntimeManagementRoutes,
  type RuntimeManagementRouteContext,
  runtimeManagementRouteInternals,
} from "./runtime-management-routes.ts";

type Body = Record<string, unknown>;

class MemoryProposalStore implements RuntimeManagementProposalStore {
  readonly proposals = new Map<string, RuntimeManagementProposal>();

  async create(proposal: RuntimeManagementProposal): Promise<void> {
    this.proposals.set(proposal.proposalId, proposal);
  }

  async consume(proposal: RuntimeManagementProposal): Promise<boolean> {
    const stored = this.proposals.get(proposal.proposalId);
    if (
      !stored ||
      stored.expiresAt <= Date.now() ||
      stored.nonce !== proposal.nonce ||
      stored.clientId !== proposal.clientId ||
      stored.requestKey !== proposal.requestKey
    ) {
      return false;
    }
    this.proposals.delete(proposal.proposalId);
    return true;
  }
}

const proposalStore = new MemoryProposalStore();

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
    proposalStore,
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
  proposalStore.proposals.clear();
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

  it("rejects proposal minting without owner authority", async () => {
    const request = makeContext("POST", "/api/runtime/manage/propose", {
      op: "remove",
      runtimeId: "vps-1",
      clientId: "origin-renderer",
    });
    request.ctx.callerAuthorization = { ok: true, role: "USER" };
    await handleRuntimeManagementRoutes(request.ctx);
    expect(request.error).toHaveBeenCalledWith(
      expect.anything(),
      "Runtime management requires owner authority.",
      403,
    );
    expect(proposalStore.proposals.size).toBe(0);
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

  it("binds each destructive request to one server proposal, target, and renderer", async () => {
    const proposed = makeContext("POST", "/api/runtime/manage/propose", {
      op: "remove",
      runtimeId: "vps-1",
      clientId: "origin-renderer",
    });
    await handleRuntimeManagementRoutes(proposed.ctx);
    const authority = proposed.json.mock.calls[0]?.[1] as {
      proposalId: string;
      proposalNonce: string;
    };

    const wrongTarget = makeContext("POST", "/api/runtime/manage", {
      op: "remove",
      runtimeId: "vps-2",
      clientId: "origin-renderer",
      ...authority,
    });
    await handleRuntimeManagementRoutes(wrongTarget.ctx);
    expect(wrongTarget.error).toHaveBeenCalledWith(
      expect.anything(),
      "Runtime proposal is missing, expired, or does not match.",
      409,
    );

    const wrongRenderer = makeContext("POST", "/api/runtime/manage", {
      op: "remove",
      runtimeId: "vps-1",
      clientId: "other-renderer",
      ...authority,
    });
    await handleRuntimeManagementRoutes(wrongRenderer.ctx);
    expect(wrongRenderer.error).toHaveBeenCalledWith(
      expect.anything(),
      "Runtime proposal is missing, expired, or does not match.",
      409,
    );

    const manage = makeContext("POST", "/api/runtime/manage", {
      op: "remove",
      runtimeId: "vps-1",
      clientId: "origin-renderer",
      ...authority,
    });
    const waiting = handleRuntimeManagementRoutes(manage.ctx);
    await flushUntil(
      () => manage.broadcastWsToClientId.mock.calls.length === 1,
    );
    const frame = manage.broadcastWsToClientId.mock.calls[0]?.[1] as {
      requestId: string;
    };
    const claim = makeContext("POST", "/api/runtime/manage/claim", {
      requestId: frame.requestId,
    });
    await handleRuntimeManagementRoutes(claim.ctx);
    const claimBody = claim.json.mock.calls[0]?.[1] as { claimToken: string };
    await handleRuntimeManagementRoutes(
      makeContext("POST", "/api/runtime/manage/result", {
        requestId: frame.requestId,
        claimToken: claimBody.claimToken,
        ok: true,
      }).ctx,
    );
    await waiting;

    const replay = makeContext("POST", "/api/runtime/manage", {
      op: "remove",
      runtimeId: "vps-1",
      clientId: "origin-renderer",
      ...authority,
    });
    await handleRuntimeManagementRoutes(replay.ctx);
    expect(replay.error).toHaveBeenCalledWith(
      expect.anything(),
      "Runtime proposal is missing, expired, or does not match.",
      409,
    );
  });

  it.each([
    ["enabled", true],
    ["disabled", false],
    ["absent", undefined],
  ] as const)(
    "preserves an %s managed-network choice through proposal and shell delivery",
    async (_label, managedNetwork) => {
      const request = {
        op: "enroll_host",
        runtimeId: "vps-1",
        clientId: "origin-renderer",
        ...(managedNetwork === undefined ? {} : { managedNetwork }),
      };
      const proposed = makeContext(
        "POST",
        "/api/runtime/manage/propose",
        request,
      );
      await handleRuntimeManagementRoutes(proposed.ctx);
      const authority = proposed.json.mock.calls[0]?.[1] as {
        proposalId: string;
        proposalNonce: string;
      };

      const manage = makeContext("POST", "/api/runtime/manage", {
        ...request,
        ...authority,
      });
      const waiting = handleRuntimeManagementRoutes(manage.ctx);
      await flushUntil(
        () => manage.broadcastWsToClientId.mock.calls.length === 1,
      );
      const frame = manage.broadcastWsToClientId.mock.calls[0]?.[1] as {
        requestId: string;
        request: Body;
      };
      expect(frame.request.managedNetwork).toBe(managedNetwork);

      const claim = makeContext("POST", "/api/runtime/manage/claim", {
        requestId: frame.requestId,
      });
      await handleRuntimeManagementRoutes(claim.ctx);
      const claimBody = claim.json.mock.calls[0]?.[1] as {
        claimToken: string;
      };
      await handleRuntimeManagementRoutes(
        makeContext("POST", "/api/runtime/manage/result", {
          requestId: frame.requestId,
          claimToken: claimBody.claimToken,
          ok: true,
        }).ctx,
      );
      await waiting;
    },
  );

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
