/**
 * Shared-runtime resolver coverage proves cold-scope hydration stays on the
 * org-scoped auth path while preserving the shared-tier and bootstrap-window
 * routing boundaries consumed by the Cloud agent REST adapter.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireUserOrApiKeyWithOrgLookup = mock(
  async <T>(_: unknown, lookup: (organizationId: string) => Promise<T>) => ({
    user: { organization_id: "org-1" },
    orgLookupResult: await lookup("org-1"),
  }),
);
const findByIdAndOrg = mock(async () => null);

mock.module("../../auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrgLookup,
}));

mock.module("../../../db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    findByIdAndOrg,
  },
}));

const { resolveSharedAgent } = await import("./resolve-shared-agent");

function contextWithAgentId(agentId?: string) {
  return {
    req: {
      param: (name: string) => (name === "agentId" ? agentId : undefined),
    },
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    organization_id: "org-1",
    execution_tier: "shared",
    status: "running",
    bridge_url: null,
    agent_name: "Shared Agent",
    ...overrides,
  };
}

beforeEach(() => {
  requireUserOrApiKeyWithOrgLookup.mockClear();
  findByIdAndOrg.mockClear();
  findByIdAndOrg.mockResolvedValue(null);
});

describe("resolveSharedAgent", () => {
  test("returns 400 without auth or repository work when the route param is missing", async () => {
    await expect(resolveSharedAgent(contextWithAgentId() as never)).resolves.toEqual({
      error: "Missing agent id",
      status: 400,
    });
    expect(requireUserOrApiKeyWithOrgLookup).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
  });

  test("uses the overlapped org lookup to resolve a shared agent", async () => {
    findByIdAndOrg.mockResolvedValue(agent());

    await expect(resolveSharedAgent(contextWithAgentId("agent-1") as never)).resolves.toMatchObject({
      agentId: "agent-1",
      orgId: "org-1",
      agentName: "Shared Agent",
    });
    expect(findByIdAndOrg).toHaveBeenCalledWith("agent-1", "org-1");
  });

  test("allows a dedicated agent only during its first bootstrap window", async () => {
    findByIdAndOrg.mockResolvedValue(
      agent({
        execution_tier: "dedicated-lazy",
        status: "provisioning",
        agent_name: null,
      }),
    );

    await expect(resolveSharedAgent(contextWithAgentId("agent-1") as never)).resolves.toMatchObject({
      agentName: "Eliza",
      agentId: "agent-1",
    });
  });

  test("rejects non-shared agents outside the bootstrap window", async () => {
    findByIdAndOrg.mockResolvedValue(
      agent({
        execution_tier: "dedicated-lazy",
        status: "running",
        bridge_url: "https://agent.example.test",
      }),
    );

    await expect(resolveSharedAgent(contextWithAgentId("agent-1") as never)).resolves.toEqual({
      error: "Not a shared-runtime agent",
      status: 404,
    });
  });

  test("returns 404 when no org-scoped agent exists", async () => {
    await expect(resolveSharedAgent(contextWithAgentId("agent-missing") as never)).resolves.toEqual({
      error: "Agent not found",
      status: 404,
    });
  });
});
