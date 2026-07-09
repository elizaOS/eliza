/**
 * Message-send bridge coverage for the cloud-to-sandbox fallback ladder.
 * The first transport is the conversation route; when it returns a structured
 * chat failure, the bridge must preserve that failure instead of masking it
 * with a later compatibility transport.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { type BridgeServiceDeps, ElizaSandboxBridgeService } from "./eliza-sandbox-bridge";

const originalFetch = globalThis.fetch;
const restoreFns: Array<() => void> = [];

function trackRestore(fn: () => void): void {
  restoreFns.push(fn);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const restore of restoreFns.splice(0).toReversed()) {
    restore();
  }
});

function sandbox(): AgentSandbox {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "22222222-2222-4222-8222-222222222222",
    user_id: "33333333-3333-4333-8333-333333333333",
    character_id: null,
    sandbox_id: "sandbox-1",
    status: "running",
    execution_tier: "custom",
    bridge_url: "https://agent.local",
    health_url: "https://agent.local/health",
    agent_name: "Eliza",
    agent_config: {},
    database_uri: "postgres://agent-db.example",
    database_status: "ready",
    database_error: null,
    snapshot_id: null,
    last_backup_at: null,
    last_heartbeat_at: null,
    error_message: null,
    error_count: 0,
    environment_vars: { ELIZA_API_TOKEN: "agent-token" },
    node_id: "node-1",
    container_name: "agent-1",
    bridge_port: 18923,
    web_ui_port: 23816,
    headscale_ip: "100.64.0.10",
    docker_image: "ghcr.io/elizaos/agent:latest",
    image_digest: null,
    previous_image_digest: null,
    previous_docker_image: null,
    target_docker_image: null,
    target_image_digest: null,
    upgrade_status: null,
    upgrade_error: null,
    upgrade_attempted_at: null,
    upgrade_completed_at: null,
    provisioning_started_at: null,
    provisioning_completed_at: null,
    provision_job_id: null,
    provision_claimed_at: null,
    provision_claim_token: null,
    provision_fail_code: null,
    provision_attempts: 0,
    wake_requested_at: null,
    last_wake_at: null,
    sleep_requested_at: null,
    last_sleep_at: null,
    created_at: new Date("2026-07-09T00:00:00.000Z"),
    updated_at: new Date("2026-07-09T00:00:00.000Z"),
  } as AgentSandbox;
}

function deps(): BridgeServiceDeps {
  return {
    getAgentApiEndpoint: async (_rec, path) => `https://agent.local${path}`,
    getAgentJsonHeaders: () => ({ authorization: "Bearer agent-token" }),
    listRuntimeAgents: async () => ({ supported: true, agents: [] }),
    selectRuntimeAgent: () => undefined,
    isRuntimeAgentReady: () => false,
    ensureRuntimeAgentStarted: async () => null,
  };
}

function response(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ElizaSandboxBridgeService message.send", () => {
  test("preserves conversation-route failureKind and does not mask it with fallback transports", async () => {
    const rec = sandbox();
    const repoSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(rec);
    trackRestore(() => repoSpy.mockRestore());

    const urls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      urls.push(url);
      if (url.endsWith("/api/conversations")) {
        return response({ conversation: { id: "conv-1" } });
      }
      if (url.endsWith("/api/conversations/conv-1/messages")) {
        return response({
          text: "Sorry, I'm having a provider issue",
          failureKind: "provider_issue",
          agentName: "Eliza",
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const bridge = new ElizaSandboxBridgeService(deps());
    const result = await bridge.bridge(rec.id, rec.organization_id, {
      jsonrpc: "2.0",
      id: "test",
      method: "message.send",
      params: {
        text: "Reply with a live token",
        roomId: "room-1",
        userId: "user-1",
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      text: "Sorry, I'm having a provider issue",
      failureKind: "provider_issue",
      transport: "conversation",
      conversationId: "conv-1",
    });
    expect(urls).toEqual([
      "https://agent.local/api/conversations",
      "https://agent.local/api/conversations/conv-1/messages",
    ]);
  });
});
