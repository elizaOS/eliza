/** Exercises the observation-only provisioning reader with deterministic fixtures. */
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import type { AgentSandbox } from "../../../db/schemas/agent-sandboxes";

const listByOrganization = mock();
const listByOrganizationSpy = spyOn(
  agentSandboxesRepository,
  "listByOrganization",
).mockImplementation((...args) => listByOrganization(...args) as never);

afterAll(() => {
  listByOrganizationSpy.mockRestore();
});

const { getElizaAppProvisioningStatus, selectElizaAppProvisioningTarget } = await import(
  `./provisioning.ts?test=provisioning-${Date.now()}`
);

function sandbox(params: {
  id: string;
  status?: AgentSandbox["status"];
  executionTier?: AgentSandbox["execution_tier"];
  poolStatus?: AgentSandbox["pool_status"];
  deletedAt?: Date | null;
  deletionAttemptId?: string | null;
  bridgeUrl?: string | null;
  createdAt?: Date;
  userId?: string;
}): AgentSandbox {
  return {
    id: params.id,
    status: params.status ?? "running",
    execution_tier: params.executionTier ?? "dedicated-always",
    pool_status: params.poolStatus ?? null,
    deleted_at: params.deletedAt ?? null,
    deletion_attempt_id: params.deletionAttemptId ?? null,
    bridge_url: params.bridgeUrl ?? null,
    created_at: params.createdAt ?? new Date("2026-08-20T00:00:00Z"),
    user_id: params.userId ?? "user-1",
  } as AgentSandbox;
}

describe("getElizaAppProvisioningStatus", () => {
  beforeEach(() => {
    listByOrganization.mockReset();
  });

  test("selects the newest non-Shared target from mixed-tier rows", async () => {
    listByOrganization.mockResolvedValue([
      sandbox({
        id: "newest-shared",
        executionTier: "shared",
        createdAt: new Date("2026-08-20T03:00:00Z"),
      }),
      sandbox({
        id: "older-dedicated",
        executionTier: "dedicated-lazy",
        createdAt: new Date("2026-08-20T01:00:00Z"),
      }),
      sandbox({
        id: "newest-dedicated",
        status: "provisioning",
        createdAt: new Date("2026-08-20T02:00:00Z"),
      }),
    ]);

    expect(await getElizaAppProvisioningStatus("org-1", "user-1")).toMatchObject({
      status: "provisioning",
      agentId: "newest-dedicated",
      bridgeUrl: null,
    });
  });

  test("never exposes another organization member's Dedicated target", async () => {
    listByOrganization.mockResolvedValue([
      sandbox({
        id: "newer-other-user",
        userId: "user-2",
        createdAt: new Date("2026-08-20T03:00:00Z"),
      }),
      sandbox({
        id: "requesting-user",
        userId: "user-1",
        createdAt: new Date("2026-08-20T02:00:00Z"),
      }),
    ]);

    expect(await getElizaAppProvisioningStatus("org-1", "user-1")).toMatchObject({
      status: "running",
      agentId: "requesting-user",
    });
  });

  test("reports none for a Shared-only organization", async () => {
    listByOrganization.mockResolvedValue([
      sandbox({ id: "shared-running", executionTier: "shared" }),
      sandbox({ id: "shared-pending", status: "pending", executionTier: "shared" }),
    ]);

    expect(await getElizaAppProvisioningStatus("org-1", "user-1")).toEqual({
      status: "none",
      agentId: null,
      bridgeUrl: null,
      sandbox: null,
    });
  });

  test("skips pool, deleted, and deletion-state Dedicated rows", async () => {
    listByOrganization.mockResolvedValue([
      sandbox({ id: "pool", poolStatus: "unclaimed" }),
      sandbox({ id: "deleted", deletedAt: new Date("2026-08-20T00:00:00Z") }),
      sandbox({ id: "deletion-attempt", deletionAttemptId: "attempt-1" }),
      sandbox({ id: "deleting", status: "deletion_pending" }),
      sandbox({ id: "failed-delete", status: "deletion_failed" }),
      sandbox({ id: "live", status: "pending", executionTier: "custom" }),
    ]);

    expect(await getElizaAppProvisioningStatus("org-1", "user-1")).toMatchObject({
      status: "pending",
      agentId: "live",
    });
  });

  test("keeps terminal and inactive lifecycle states observable", async () => {
    for (const status of ["error", "disconnected", "stopped", "sleeping"] as const) {
      listByOrganization.mockResolvedValueOnce([sandbox({ id: `agent-${status}`, status })]);

      expect(await getElizaAppProvisioningStatus("org-1", "user-1")).toMatchObject({
        status,
        agentId: `agent-${status}`,
      });
    }
  });

  test("breaks equal-created-at ties by id independently of input order", () => {
    const createdAt = new Date("2026-08-20T04:00:00Z");
    const lower = sandbox({ id: "agent-a", createdAt });
    const higher = sandbox({ id: "agent-b", createdAt });

    expect(selectElizaAppProvisioningTarget([lower, higher], "user-1")?.id).toBe("agent-b");
    expect(selectElizaAppProvisioningTarget([higher, lower], "user-1")?.id).toBe("agent-b");
  });

  test("returns a running bridge only for the selected live Dedicated row", async () => {
    listByOrganization.mockResolvedValue([
      sandbox({
        id: "dedicated-running",
        bridgeUrl: "https://agent.example",
        executionTier: "dedicated-lazy",
      }),
    ]);

    expect(await getElizaAppProvisioningStatus("org-1", "user-1")).toMatchObject({
      status: "running",
      agentId: "dedicated-running",
      bridgeUrl: "https://agent.example",
    });
  });

  test("propagates repository failures instead of fabricating an empty status", async () => {
    listByOrganization.mockRejectedValue(new Error("sandbox lookup failed"));

    await expect(getElizaAppProvisioningStatus("org-1", "user-1")).rejects.toThrow(
      "sandbox lookup failed",
    );
  });
});
