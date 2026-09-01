/**
 * Deterministic boundary tests prove guest Entity attribution comes from the
 * canonical auth resolver plus a unique verified graph binding, never headers.
 */

import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@elizaos/app-core/api/auth", () => ({
  resolveAuthorizedRouteRole: mocks.auth,
}));

vi.mock("@elizaos/app-core/services/auth-store", () => ({
  AuthStore: class AuthStore {},
}));

vi.mock("@elizaos/agent", () => ({
  resolveKnowledgeGraphService: () => ({
    getEntityStore: () => ({ resolve: mocks.resolve }),
  }),
}));

import {
  AUTH_SESSION_CONNECTOR_ACCOUNT,
  AUTH_SESSION_ENTITY_PLATFORM,
  resolveLifeOpsAuthenticatedPrincipal,
} from "./authenticated-entity-principal.js";

const runtime = { agentId: "agent-1" } as AgentRuntime;
const req = {
  method: "GET",
  headers: { "x-eliza-entity-id": "spoofed-owner" },
  socket: { remoteAddress: "203.0.113.10" },
} as http.IncomingMessage;

function candidate(entityId: string, authIdentityId: string, verified = true) {
  return {
    entity: {
      entityId,
      type: "person",
      identities: [
        {
          platform: AUTH_SESSION_ENTITY_PLATFORM,
          connectorAccountId: AUTH_SESSION_CONNECTOR_ACCOUNT,
          handle: authIdentityId,
          verified,
        },
      ],
    },
  };
}

describe("authenticated LifeOps Entity principal", () => {
  beforeEach(() => {
    mocks.auth.mockReset();
    mocks.resolve.mockReset();
  });

  it("maps an owner session to self without consulting spoofed headers", async () => {
    mocks.auth.mockResolvedValue({
      ok: true,
      role: "OWNER",
      identityId: "owner-auth",
    });
    await expect(
      resolveLifeOpsAuthenticatedPrincipal({ req, runtime }),
    ).resolves.toEqual({
      ok: true,
      principal: {
        kind: "owner",
        entityId: "self",
        authIdentityId: "owner-auth",
      },
    });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("maps the intended guest only through a unique verified auth binding", async () => {
    mocks.auth.mockResolvedValue({
      ok: true,
      role: "USER",
      identityId: "guest-auth",
    });
    mocks.resolve.mockResolvedValue([candidate("guest-entity", "guest-auth")]);
    await expect(
      resolveLifeOpsAuthenticatedPrincipal({ req, runtime }),
    ).resolves.toMatchObject({
      ok: true,
      principal: { kind: "guest", entityId: "guest-entity" },
    });
  });

  it("rejects unauthenticated, unverified, and ambiguous guest identities", async () => {
    mocks.auth.mockResolvedValueOnce({
      ok: false,
      status: 401,
      reason: "Unauthorized",
    });
    await expect(
      resolveLifeOpsAuthenticatedPrincipal({ req, runtime }),
    ).resolves.toMatchObject({ ok: false, status: 401 });

    mocks.auth.mockResolvedValue({
      ok: true,
      role: "USER",
      identityId: "guest-auth",
    });
    mocks.resolve.mockResolvedValueOnce([
      candidate("wrong-guest", "guest-auth", false),
    ]);
    await expect(
      resolveLifeOpsAuthenticatedPrincipal({ req, runtime }),
    ).resolves.toMatchObject({ ok: false, status: 403 });

    mocks.resolve.mockResolvedValueOnce([
      candidate("guest-a", "guest-auth"),
      candidate("guest-b", "guest-auth"),
    ]);
    await expect(
      resolveLifeOpsAuthenticatedPrincipal({ req, runtime }),
    ).resolves.toMatchObject({ ok: false, status: 403 });
  });
});
