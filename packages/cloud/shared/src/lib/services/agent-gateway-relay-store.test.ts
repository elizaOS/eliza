/**
 * Pins the per-call store construction in agentGatewayRelayService.
 *
 * On Cloudflare Workers a Redis TCP connection is bound to the request that
 * opened it, so the service must NOT cache a Redis-backed store across calls
 * (the cached socket poisons the isolate — observed live as the e2e relay
 * disconnect 500 on staging). MOCK_REDIS's backing map is process-global by
 * design, which is exactly what lets these tests assert that state written
 * through one per-call store instance is visible through the next.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["MOCK_REDIS", "REDIS_URL", "KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("agentGatewayRelayService store scoping", () => {
  test("full session lifecycle works across per-call Redis store instances", async () => {
    process.env.MOCK_REDIS = "1";
    const { agentGatewayRelayService } = await import("./agent-gateway-relay");
    agentGatewayRelayService.resetForTests(null);

    const session = await agentGatewayRelayService.registerSession({
      organizationId: "org-1",
      userId: "user-1",
      runtimeAgentId: "agent-1",
      agentName: "Test Agent",
    });

    // Each call builds a fresh store; the round-trip only works if the
    // backing state is shared by the BACKEND (mock map / real Redis), not by
    // a cached client.
    const fetched = await agentGatewayRelayService.getSession(session.id);
    expect(fetched?.id).toBe(session.id);
    expect(fetched?.runtimeAgentId).toBe("agent-1");

    await agentGatewayRelayService.disconnectSession(session.id);
    expect(await agentGatewayRelayService.getSession(session.id)).toBeNull();
  });

  test("without Redis, relay state still survives across calls via the shared in-memory store", async () => {
    const { agentGatewayRelayService } = await import("./agent-gateway-relay");
    agentGatewayRelayService.resetForTests(null);

    const session = await agentGatewayRelayService.registerSession({
      organizationId: "org-2",
      userId: "user-2",
      runtimeAgentId: "agent-2",
    });

    const fetched = await agentGatewayRelayService.getSession(session.id);
    expect(fetched?.id).toBe(session.id);

    await agentGatewayRelayService.disconnectSession(session.id);
    expect(await agentGatewayRelayService.getSession(session.id)).toBeNull();
  });
});
