/** Pins the historical provisioning route as an observation-only compatibility surface. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  createProvisioningAgentObservationApp,
  type ProvisioningAgentObservationDependencies,
} from "../eliza-app/provisioning-agent/route";

const listByOrganization = mock(
  async (_organizationId: string) => [] as SandboxFixture[],
);
const validateAuthHeader = mock(async (header: string) =>
  header.startsWith("Bearer ")
    ? { userId: "user-1", organizationId: "org-1" }
    : null,
);
const logError = mock();

const app = createProvisioningAgentObservationApp({
  sandboxes: { listByOrganization },
  sessions: { validateAuthHeader },
  log: { error: logError },
} as unknown as ProvisioningAgentObservationDependencies);

interface SandboxFixture {
  id: string;
  status: string;
  execution_tier: string;
  bridge_url: string | null;
  created_at: Date;
  pool_status: string | null;
  deleted_at: Date | null;
  deletion_attempt_id: string | null;
  user_id: string;
}

function sandbox(params: {
  id: string;
  status?: string;
  executionTier?: string;
  bridgeUrl?: string | null;
  createdAt?: Date;
  poolStatus?: string | null;
  deletedAt?: Date | null;
  deletionAttemptId?: string | null;
  userId?: string;
}): SandboxFixture {
  return {
    id: params.id,
    status: params.status ?? "running",
    execution_tier: params.executionTier ?? "dedicated-always",
    bridge_url: params.bridgeUrl ?? null,
    created_at: params.createdAt ?? new Date("2026-08-20T00:00:00Z"),
    pool_status: params.poolStatus ?? null,
    deleted_at: params.deletedAt ?? null,
    deletion_attempt_id: params.deletionAttemptId ?? null,
    user_id: params.userId ?? "user-1",
  };
}

function request(method: "GET" | "POST", authorized = true) {
  return new Request("http://localhost/", {
    method,
    headers: authorized ? { Authorization: "Bearer valid-session-token" } : {},
  });
}

describe("provisioning-agent observation-only route", () => {
  beforeEach(() => {
    listByOrganization.mockReset();
    listByOrganization.mockResolvedValue([]);
    validateAuthHeader.mockClear();
    logError.mockClear();
  });

  test("GET uses the canonical selector for mixed Shared and Dedicated rows", async () => {
    listByOrganization.mockResolvedValue([
      sandbox({
        id: "newest-shared",
        executionTier: "shared",
        createdAt: new Date("2026-08-20T03:00:00Z"),
      }),
      sandbox({
        id: "older-dedicated",
        createdAt: new Date("2026-08-20T01:00:00Z"),
      }),
      sandbox({
        id: "newest-dedicated",
        status: "error",
        createdAt: new Date("2026-08-20T02:00:00Z"),
      }),
    ]);

    const response = await app.fetch(request("GET"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { status: "error", agentId: "newest-dedicated" },
    });
  });

  test("GET reports none for a Shared-only organization", async () => {
    listByOrganization.mockResolvedValue([
      sandbox({ id: "shared-only", executionTier: "shared" }),
    ]);

    const response = await app.fetch(request("GET"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { status: "none" },
    });
  });

  test("GET surfaces a newer failed deletion instead of falling back to an older running row", async () => {
    listByOrganization.mockResolvedValue([
      sandbox({
        id: "older-running",
        bridgeUrl: "https://older.example",
        createdAt: new Date("2026-08-20T01:00:00Z"),
      }),
      sandbox({
        id: "newer-failed-deletion",
        status: "deletion_failed",
        deletionAttemptId: "delete-attempt-1",
        createdAt: new Date("2026-08-20T02:00:00Z"),
      }),
    ]);

    const response = await app.fetch(request("GET"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        status: "deletion_failed",
        agentId: "newer-failed-deletion",
      },
    });
  });

  test("GET does not expose another organization member's Dedicated target", async () => {
    listByOrganization.mockResolvedValue([
      sandbox({ id: "other-user", userId: "user-2" }),
      sandbox({ id: "requesting-user", userId: "user-1", status: "sleeping" }),
    ]);

    const response = await app.fetch(request("GET"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { status: "sleeping", agentId: "requesting-user" },
    });
  });

  test("retired POST performs exactly the same observation and owns no mutation dependency", async () => {
    const response = await app.fetch(request("POST"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { status: "none" },
    });
    expect(validateAuthHeader).toHaveBeenCalledTimes(1);
    expect(listByOrganization).toHaveBeenCalledWith("org-1");
  });

  test("retired POST returns an existing Dedicated status without changing it", async () => {
    listByOrganization.mockResolvedValue([
      sandbox({
        id: "dedicated-running",
        bridgeUrl: "https://agent.example",
        executionTier: "dedicated-lazy",
      }),
    ]);

    const response = await app.fetch(request("POST"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        status: "running",
        agentId: "dedicated-running",
        bridgeUrl: "https://agent.example",
      },
    });
    expect(listByOrganization).toHaveBeenCalledTimes(1);
  });

  test("both observation methods require a session", async () => {
    for (const method of ["GET", "POST"] as const) {
      const response = await app.fetch(request(method, false));
      expect(response.status).toBe(401);
    }
    expect(listByOrganization).not.toHaveBeenCalled();
  });

  test("repository failures remain visible without a mutation fallback", async () => {
    listByOrganization.mockRejectedValue(new Error("database unavailable"));

    const response = await app.fetch(request("POST"));

    expect(response.status).toBe(500);
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
