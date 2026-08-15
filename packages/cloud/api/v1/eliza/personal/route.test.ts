/** Verifies read-only personal identity resolution never enters chat or provisioning. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "00000000-0000-4000-8000-000000000002",
  organization_id: "00000000-0000-4000-8000-000000000001",
}));
let activeTarget: {
  id: string;
  agent_name: string;
  headscale_ip: string;
} | null = null;
const findActivePersonalDedicatedTarget = mock(async () => activeTarget);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/agent-tier-upgrade-target", () => ({
  findActivePersonalDedicatedTarget,
}));

const { default: app } = await import("./route");

describe("personal Eliza identity", () => {
  beforeEach(() => {
    activeTarget = null;
    requireUserOrApiKeyWithOrg.mockClear();
    findActivePersonalDedicatedTarget.mockClear();
  });

  test("returns one deterministic rowless Shared identity", async () => {
    const response = await app.request("/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: {
        identity: { id: string; displayName: string; runtime: string };
      };
    };
    expect(body).toEqual({
      success: true,
      data: {
        identity: {
          id: expect.stringMatching(/^personal:/),
          displayName: "Eliza",
          runtime: "shared",
        },
      },
    });
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(findActivePersonalDedicatedTarget).toHaveBeenCalledTimes(1);
  });

  test("returns the server-owned Dedicated primary after cutover", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      agent_name: "Eliza",
      headscale_ip: "100.64.0.20",
    };

    const response = await app.request(
      "/",
      {},
      {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app",
      },
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      success: true,
      data: {
        identity: {
          id: expect.stringMatching(/^personal:/),
          displayName: "Eliza",
          runtime: "dedicated",
          activeAgentId: "00000000-0000-4000-8000-000000000020",
          apiBase:
            "https://00000000-0000-4000-8000-000000000020.cloud.eliza.app",
        },
      },
    });
  });
});
