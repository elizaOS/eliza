/**
 * Exercises the remote-session list and revoke route boundaries with mocked
 * persistence so same-organization users cannot inspect or mutate each
 * other's remote-control sessions.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const ownerId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: ownerId,
  organization_id: organizationId,
}));
const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: ownerId, organization_id: organizationId },
}));
const findByIdAndOrg = mock();
const findByIdAndOwner = mock();
const listActiveByAgent = mock();
const revoke = mock();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/auth", () => ({ requireAuthOrApiKeyWithOrg }));
mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: { findByIdAndOrg },
}));
mock.module("@/db/repositories/remote-sessions", () => ({
  remoteSessionsRepository: {
    findByIdAndOwner,
    listActiveByAgent,
    revoke,
  },
}));

const { default: listRoute } = await import("./route");
const { default: revokeRoute } = await import("./[id]/revoke/route");

const app = new Hono<AppEnv>();
app.route("/api/v1/remote/sessions", listRoute);
app.route("/api/v1/remote/sessions/:id/revoke", revokeRoute);

describe("remote session owner boundaries", () => {
  beforeEach(() => {
    findByIdAndOrg.mockReset();
    findByIdAndOwner.mockReset();
    listActiveByAgent.mockReset();
    revoke.mockReset();
    findByIdAndOrg.mockResolvedValue({ id: agentId, user_id: ownerId });
    listActiveByAgent.mockResolvedValue([]);
  });

  test("lists sessions through organization and authenticated-owner scope", async () => {
    const response = await app.request(
      `/api/v1/remote/sessions?agentId=${agentId}`,
    );

    expect(response.status).toBe(200);
    expect(listActiveByAgent).toHaveBeenCalledWith(
      agentId,
      organizationId,
      ownerId,
    );
  });

  test("hides another same-organization user's agent sessions", async () => {
    findByIdAndOrg.mockResolvedValue({
      id: agentId,
      user_id: "55555555-5555-4555-8555-555555555555",
    });

    const response = await app.request(
      `/api/v1/remote/sessions?agentId=${agentId}`,
    );

    expect(response.status).toBe(404);
    expect(listActiveByAgent).not.toHaveBeenCalled();
  });

  test("looks up and revokes a session through authenticated-owner scope", async () => {
    const active = {
      id: sessionId,
      status: "active",
      ended_at: null,
    };
    findByIdAndOwner.mockResolvedValue(active);
    revoke.mockResolvedValue({
      ...active,
      status: "revoked",
      ended_at: new Date("2026-08-18T20:00:00.000Z"),
    });

    const response = await app.request(
      `/api/v1/remote/sessions/${sessionId}/revoke`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(findByIdAndOwner).toHaveBeenCalledWith(
      sessionId,
      organizationId,
      ownerId,
    );
    expect(revoke).toHaveBeenCalledWith(sessionId, organizationId, ownerId);
  });

  test("does not reveal or revoke another owner's session", async () => {
    findByIdAndOwner.mockResolvedValue(undefined);

    const response = await app.request(
      `/api/v1/remote/sessions/${sessionId}/revoke`,
      { method: "POST" },
    );

    expect(response.status).toBe(404);
    expect(revoke).not.toHaveBeenCalled();
  });
});
