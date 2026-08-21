/** Pins provisioning chat observation to canonical Dedicated authority and honest copy. */
import { describe, expect, mock, test } from "bun:test";
import type { AgentSandbox } from "../../db/schemas/agent-sandboxes";
import {
  buildProvisioningChatGenerationInput,
  buildProvisioningChatSystemPrompt,
  type ProvisioningAgentChatSandboxReader,
  resolveProvisioningAgentChatTarget,
} from "./provisioning-agent-chat";

function sandbox(params: {
  id: string;
  status?: AgentSandbox["status"];
  executionTier?: AgentSandbox["execution_tier"];
  createdAt?: Date;
  poolStatus?: AgentSandbox["pool_status"];
  deletedAt?: Date | null;
  userId?: string;
}): AgentSandbox {
  return {
    id: params.id,
    status: params.status ?? "running",
    execution_tier: params.executionTier ?? "dedicated-always",
    created_at: params.createdAt ?? new Date("2026-08-20T00:00:00Z"),
    pool_status: params.poolStatus ?? null,
    deleted_at: params.deletedAt ?? null,
    deletion_attempt_id: null,
    user_id: params.userId ?? "user-1",
  } as AgentSandbox;
}

function reader(
  params: { requested?: AgentSandbox; inventory?: AgentSandbox[]; error?: Error } = {},
): {
  repository: ProvisioningAgentChatSandboxReader;
  findByIdAndOrg: ReturnType<typeof mock>;
  listByOrganization: ReturnType<typeof mock>;
} {
  const findByIdAndOrg = mock(async () => {
    if (params.error) throw params.error;
    return params.requested;
  });
  const listByOrganization = mock(async () => {
    if (params.error) throw params.error;
    return params.inventory ?? [];
  });

  return {
    repository: {
      findByIdAndOrg,
      listByOrganization,
    } as unknown as ProvisioningAgentChatSandboxReader,
    findByIdAndOrg,
    listByOrganization,
  };
}

describe("resolveProvisioningAgentChatTarget", () => {
  test("selects the newest user-owned Dedicated row from unordered mixed tiers", async () => {
    const { repository } = reader({
      inventory: [
        sandbox({ id: "older", createdAt: new Date("2026-08-20T01:00:00Z") }),
        sandbox({
          id: "newest-shared",
          executionTier: "shared",
          createdAt: new Date("2026-08-20T03:00:00Z"),
        }),
        sandbox({
          id: "newest-dedicated",
          status: "error",
          createdAt: new Date("2026-08-20T02:00:00Z"),
        }),
      ],
    });

    const result = await resolveProvisioningAgentChatTarget(
      "user-1",
      "org-1",
      undefined,
      repository,
    );

    expect(result?.id).toBe("newest-dedicated");
    expect(result?.status).toBe("error");
  });

  test("rejects a requested Shared row and falls back to Dedicated authority", async () => {
    const { repository } = reader({
      requested: sandbox({ id: "requested-shared", executionTier: "shared" }),
      inventory: [sandbox({ id: "dedicated-running" })],
    });

    const result = await resolveProvisioningAgentChatTarget(
      "user-1",
      "org-1",
      "requested-shared",
      repository,
    );

    expect(result?.id).toBe("dedicated-running");
  });

  test("rejects another user's requested row and falls back to the caller's target", async () => {
    const { repository } = reader({
      requested: sandbox({ id: "other-user", userId: "user-2" }),
      inventory: [sandbox({ id: "caller-target", status: "stopped" })],
    });

    const result = await resolveProvisioningAgentChatTarget(
      "user-1",
      "org-1",
      "other-user",
      repository,
    );

    expect(result?.id).toBe("caller-target");
    expect(result?.status).toBe("stopped");
  });

  test("does not echo a rejected requested id when no Dedicated target exists", async () => {
    const { repository } = reader({
      requested: sandbox({ id: "requested-pool", poolStatus: "unclaimed" }),
    });

    expect(
      await resolveProvisioningAgentChatTarget("user-1", "org-1", "requested-pool", repository),
    ).toBeUndefined();
  });

  test("keeps an inactive Dedicated state observable", async () => {
    const inactive = sandbox({ id: "dedicated-sleeping", status: "sleeping" });
    const { repository } = reader({
      requested: inactive,
      inventory: [inactive],
    });

    const result = await resolveProvisioningAgentChatTarget(
      "user-1",
      "org-1",
      "dedicated-sleeping",
      repository,
    );

    expect(result?.status).toBe("sleeping");
  });

  test("serves the canonical target when the client holds a superseded id", async () => {
    // The hook used to keep the first agent id it ever saw, so a client can
    // send an id the status endpoint has already moved past. Chat must not
    // follow it, or status and chat disagree and the transcript handoff
    // targets the wrong agent.
    const older = sandbox({
      id: "agent-a",
      createdAt: new Date("2026-08-20T00:00:00Z"),
    });
    const newer = sandbox({
      id: "agent-b",
      createdAt: new Date("2026-08-20T01:00:00Z"),
    });
    const { repository } = reader({
      requested: older,
      inventory: [older, newer],
    });

    const result = await resolveProvisioningAgentChatTarget(
      "user-1",
      "org-1",
      "agent-a",
      repository,
    );

    expect(result?.id).toBe("agent-b");
  });

  test("returns no target for a Shared-only inventory", async () => {
    const { repository } = reader({
      inventory: [sandbox({ id: "shared-only", executionTier: "shared" })],
    });

    expect(
      await resolveProvisioningAgentChatTarget("user-1", "org-1", undefined, repository),
    ).toBeUndefined();
  });

  test("propagates authority read errors so the caller can report unknown", async () => {
    const { repository } = reader({ error: new Error("primary unavailable") });

    expect(
      resolveProvisioningAgentChatTarget("user-1", "org-1", undefined, repository),
    ).rejects.toThrow("primary unavailable");
  });
});

describe("buildProvisioningChatSystemPrompt", () => {
  test.each([
    ["disconnected", "status: disconnected"],
    ["stopped", "status: stopped"],
    ["sleeping", "status: sleeping"],
    ["none", "No eligible Dedicated container"],
    ["unknown", "status lookup is currently unavailable"],
  ] as const)("describes %s without fabricating active setup", (status, expected) => {
    const prompt = buildProvisioningChatSystemPrompt(status);

    expect(prompt).toContain(expected);
    expect(prompt).not.toContain("still being set up");
    expect(prompt).not.toContain("while their dedicated container is provisioning");
  });

  test("does not infer a job or ETA from a pending row", () => {
    const prompt = buildProvisioningChatSystemPrompt("pending");

    expect(prompt).toContain("status: pending");
    expect(prompt).toContain("does not prove that provisioning was requested");
    expect(prompt).not.toContain("2–5 minutes");
  });

  test("reports provisioning as recorded state without a readiness promise", () => {
    const prompt = buildProvisioningChatSystemPrompt("provisioning");

    expect(prompt).toContain("status: provisioning");
    expect(prompt).toContain("does not prove current readiness or an ETA");
  });

  test("does not infer live readiness from a running database row", () => {
    const prompt = buildProvisioningChatSystemPrompt("running");

    expect(prompt).toContain("database status: running");
    expect(prompt).toContain("does not prove live readiness");
    expect(prompt).not.toContain("transfer them automatically");
  });

  test("does not infer the failed lifecycle operation from error", () => {
    const prompt = buildProvisioningChatSystemPrompt("error");

    expect(prompt).toContain("database status: error");
    expect(prompt).toContain("does not identify which lifecycle operation failed");
    expect(prompt).not.toContain("Provisioning did not complete");
  });

  test("pins the honest status prompt in the payload passed to inference", () => {
    const messages = [{ role: "user" as const, content: "What is my status?" }];

    const input = buildProvisioningChatGenerationInput("disconnected", messages);

    expect(input.messages).toBe(messages);
    expect(input.system).toContain("status: disconnected");
    expect(input.system).toContain("not being provisioned");
  });
});
