/**
 * Agent-token minting route — service-secret compare must be constant-time
 * (#12227 M1) and the human leg must be bound to platform or owning-org
 * authority: an org "admin" is a per-organization role, so minting for an
 * agentId outside the caller's org must 403 without minting. The `===` was
 * replaced with `timingSafeEqualSecret`; these drive the real route with
 * mocked auth/repository edges.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

class MockApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const mintAgentToken = mock(async (agentId: string) => ({
  token: `jwt-for-${agentId}`,
  expiresAt: "2026-01-01T00:00:00Z",
}));
let currentUser: Record<string, unknown> | null = null;
const getCurrentUser = mock(async () => currentUser);
let requireAdminBehavior: () => Promise<unknown> = async () => {
  throw new MockApiError(401, "Authentication required");
};
const requireAdmin = mock(() => requireAdminBehavior());
let sandboxForOrg: Record<string, unknown> | undefined;
const findByIdAndOrg = mock(async () => sandboxForOrg);

mock.module("@/lib/api/cloud-worker-errors", () => ({
  ApiError: MockApiError,
}));
mock.module("@/lib/auth/agent-token", () => ({ mintAgentToken }));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser,
  requireAdmin,
}));
mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: { findByIdAndOrg },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

const { default: agentTokensRoute } = await import("./route");

const SECRET = "super-secret-service-token-value";
const ENV = { ELIZA_CLOUD_SERVICE_TOKEN: SECRET };

function post(
  headers: Record<string, string>,
  body: Record<string, unknown> = { agentId: "agent-xyz" },
) {
  const app = new Hono();
  app.route("/api/v1/agent-tokens", agentTokensRoute);
  return app.fetch(
    new Request("https://api.example.test/api/v1/agent-tokens", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    ENV,
  );
}

describe("agent-tokens route — constant-time service-secret gate (M1)", () => {
  beforeEach(() => {
    mintAgentToken.mockClear();
    getCurrentUser.mockClear();
    requireAdmin.mockClear();
    findByIdAndOrg.mockClear();
    currentUser = null;
    sandboxForOrg = undefined;
    requireAdminBehavior = async () => {
      throw new MockApiError(401, "Authentication required");
    };
  });

  test("the source has no plain === / !== secret comparison", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./route.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("timingSafeEqualSecret");
    expect(src).not.toMatch(/supplied\s*===\s*expected/);
    expect(src).not.toMatch(/supplied\s*!==\s*expected/);
  });

  test("the exact service token mints a JWT", async () => {
    const res = await post({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      token: "jwt-for-agent-xyz",
    });
    expect(mintAgentToken).toHaveBeenCalledTimes(1);
  });

  test("a 1-byte-off service token is rejected 401 and mints nothing", async () => {
    const oneOff = `${SECRET.slice(0, -1)}X`;
    const res = await post({ authorization: `Bearer ${oneOff}` });
    expect(res.status).toBe(401);
    expect(mintAgentToken).not.toHaveBeenCalled();
  });

  test("a length-mismatched token is rejected 401 (no timingSafeEqual throw)", async () => {
    const res = await post({ "x-eliza-service-token": `${SECRET}extra` });
    expect(res.status).toBe(401);
    expect(mintAgentToken).not.toHaveBeenCalled();
  });

  test("an absent token is rejected 401", async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect(mintAgentToken).not.toHaveBeenCalled();
  });
});

describe("agent-tokens route — human-leg tenant binding", () => {
  beforeEach(() => {
    mintAgentToken.mockClear();
    getCurrentUser.mockClear();
    requireAdmin.mockClear();
    findByIdAndOrg.mockClear();
    currentUser = null;
    sandboxForOrg = undefined;
    requireAdminBehavior = async () => {
      throw new MockApiError(401, "Authentication required");
    };
  });

  test("a platform admin mints for any agentId", async () => {
    requireAdminBehavior = async () => ({
      user: { id: "admin-1", organization_id: "org-ops" },
      role: "super_admin",
    });
    const res = await post({});
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      token: "jwt-for-agent-xyz",
    });
    expect(mintAgentToken).toHaveBeenCalledTimes(1);
    expect(findByIdAndOrg).not.toHaveBeenCalled();
  });

  test("an org admin mints for an agent owned by their organization", async () => {
    requireAdminBehavior = async () => {
      throw new MockApiError(403, "Admin access required");
    };
    currentUser = { id: "user-1", role: "admin", organization_id: "org-1" };
    sandboxForOrg = { id: "agent-xyz", organization_id: "org-1" };

    const res = await post({});
    expect(res.status).toBe(200);
    expect(findByIdAndOrg).toHaveBeenCalledWith("agent-xyz", "org-1");
    expect(mintAgentToken).toHaveBeenCalledTimes(1);
  });

  test("an org admin is denied for another tenant's agentId and mints nothing", async () => {
    requireAdminBehavior = async () => {
      throw new MockApiError(403, "Admin access required");
    };
    currentUser = { id: "user-1", role: "admin", organization_id: "org-1" };
    sandboxForOrg = undefined;

    const res = await post({});
    expect(res.status).toBe(403);
    expect(findByIdAndOrg).toHaveBeenCalledWith("agent-xyz", "org-1");
    expect(mintAgentToken).not.toHaveBeenCalled();
  });

  test("an authenticated non-admin user is denied 403", async () => {
    requireAdminBehavior = async () => {
      throw new MockApiError(403, "Admin access required");
    };
    currentUser = { id: "user-2", role: "member", organization_id: "org-1" };

    const res = await post({});
    expect(res.status).toBe(403);
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(mintAgentToken).not.toHaveBeenCalled();
  });

  test("a service token still wins over a failing human leg", async () => {
    const res = await post({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(requireAdmin).not.toHaveBeenCalled();
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  test("agentId is still required after the human leg authorizes", async () => {
    requireAdminBehavior = async () => ({
      user: { id: "admin-1", organization_id: "org-ops" },
      role: "super_admin",
    });
    const res = await post({}, {});
    expect(res.status).toBe(400);
    expect(mintAgentToken).not.toHaveBeenCalled();
  });
});
