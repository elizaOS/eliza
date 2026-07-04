/**
 * Unit coverage for cloud handoff-target resolution. Capacitor mocked, no live
 * cloud.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { ElizaClient } from "./client-base";
// Side-effect import: patches startCloudAgentHandoff onto the prototype.
import "./client-cloud";
import type { CloudCompatAgent } from "./client-types-cloud";

/**
 * Phase 1 (create-both): the shared agent the user chats on is container-free
 * and never grows a dedicated base, so the handoff readiness probe must poll a
 * SEPARATE dedicated agent. `dedicatedAgentId` selects that target; omitting it
 * keeps the pre-shared-tier behavior (poll the same `agentId`). These tests pin
 * which agent id the probe reads from.
 */

function runningDedicated(
  overrides: Partial<CloudCompatAgent> = {},
): CloudCompatAgent {
  return {
    agent_id: "dedicated-1",
    agent_name: "Eliza",
    node_id: null,
    container_id: null,
    headscale_ip: null,
    bridge_url: null,
    web_ui_url: "https://dedicated-1.elizacloud.ai",
    status: "running",
    agent_config: {},
    created_at: "2026-06-27T00:00:00.000Z",
    updated_at: "2026-06-27T00:00:00.000Z",
    containerUrl: "",
    webUiUrl: "https://dedicated-1.elizacloud.ai",
    database_status: "ok",
    error_message: null,
    last_heartbeat_at: null,
    ...overrides,
  };
}

function fakeClient(detailById: Record<string, CloudCompatAgent>) {
  const getCloudCompatAgent = vi.fn(async (id: string) => {
    const data = detailById[id];
    return data ? { success: true, data } : { success: false, data: null };
  });
  const client = Object.create(ElizaClient.prototype) as ElizaClient;
  Object.assign(client, { getCloudCompatAgent });
  return { client, getCloudCompatAgent };
}

const SHARED_BASE = "https://elizacloud.ai/api/v1/eliza/agents/shared-1/api";

describe("startCloudAgentHandoff — dedicated migration target", () => {
  // The handoff reads the shared conversation over `fetch` (authedFetch). Stub
  // it to an empty conversation so the flow reaches the switch without import —
  // these tests only pin which agent the readiness probe targets.
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ messages: [] }),
      })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("polls the SEPARATE dedicated agent, not the shared source", async () => {
    // Only the dedicated agent ever exposes a base; the shared one stays
    // container-free. The probe must read the dedicated id or it never resolves.
    const { client, getCloudCompatAgent } = fakeClient({
      "dedicated-1": runningDedicated(),
    });

    const onSwitch = vi.fn();
    const result = await client.startCloudAgentHandoff({
      agentId: "shared-1",
      sharedApiBase: SHARED_BASE,
      conversationId: "shared-1",
      dedicatedAgentId: "dedicated-1",
      cloudApiBase: "https://www.elizacloud.ai",
      authToken: "tok",
      onSwitch,
      intervalMs: 1,
      timeoutMs: 200,
      // No shared messages → switch without import; we only assert the target.
      log: () => {},
    });

    expect(getCloudCompatAgent).toHaveBeenCalledWith("dedicated-1");
    expect(getCloudCompatAgent).not.toHaveBeenCalledWith("shared-1");
    expect(onSwitch).toHaveBeenCalledWith("https://dedicated-1.elizacloud.ai");
    expect(
      result.status === "switched" || result.status === "switched-empty",
    ).toBe(true);
  });

  it("defaults to polling `agentId` when no dedicated target is given", async () => {
    const { client, getCloudCompatAgent } = fakeClient({
      "agent-self": runningDedicated({
        agent_id: "agent-self",
        web_ui_url: "https://agent-self.elizacloud.ai",
        webUiUrl: "https://agent-self.elizacloud.ai",
      }),
    });

    await client.startCloudAgentHandoff({
      agentId: "agent-self",
      sharedApiBase: SHARED_BASE,
      conversationId: "agent-self",
      cloudApiBase: "https://www.elizacloud.ai",
      authToken: "tok",
      onSwitch: vi.fn(),
      intervalMs: 1,
      timeoutMs: 200,
      log: () => {},
    });

    expect(getCloudCompatAgent).toHaveBeenCalledWith("agent-self");
  });
});
