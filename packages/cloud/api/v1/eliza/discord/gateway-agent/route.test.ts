/**
 * Pins the managed Discord gateway route's quota boundary: it delegates the
 * primary-backed atomic admission to the service and translates an at-cap
 * refusal to the canonical API envelope.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as compatActual from "@/lib/api/compat-envelope";
import * as authActual from "@/lib/auth/workers-hono-auth";
import * as managedDiscordActual from "@/lib/services/agent-managed-discord";
import { AgentQuotaExceededError } from "@/lib/services/eliza-sandbox";

const authSnapshot = { ...authActual };
const compatSnapshot = { ...compatActual };
const managedDiscordSnapshot = { ...managedDiscordActual };

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "00000000-0000-4000-8000-000000000002",
  organization_id: "00000000-0000-4000-8000-000000000001",
}));
const ensureGatewayAgent = mock(async () => ({
  created: false,
  sandbox: { id: "00000000-0000-4000-8000-000000000003" },
}));
const toCompatAgent = mock((sandbox: { id: string }) => ({
  agent_id: sandbox.id,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...authSnapshot,
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/api/compat-envelope", () => ({
  ...compatSnapshot,
  toCompatAgent,
}));
mock.module("@/lib/services/agent-managed-discord", () => ({
  ...managedDiscordSnapshot,
  managedAgentDiscordService: {
    ...managedDiscordSnapshot.managedAgentDiscordService,
    ensureGatewayAgent,
  },
}));
const { default: app } = await import(
  `./route.ts?test=gateway-quota-${Date.now()}`
);

afterAll(() => {
  mock.module("@/lib/auth/workers-hono-auth", () => authSnapshot);
  mock.module("@/lib/api/compat-envelope", () => compatSnapshot);
  mock.module(
    "@/lib/services/agent-managed-discord",
    () => managedDiscordSnapshot,
  );
});

describe("POST /api/v1/eliza/discord/gateway-agent", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    ensureGatewayAgent.mockClear();
    ensureGatewayAgent.mockResolvedValue({
      created: false,
      sandbox: { id: "00000000-0000-4000-8000-000000000003" },
    });
    toCompatAgent.mockClear();
  });

  test("delegates quota admission to the atomic service authority", async () => {
    const response = await app.request("/", { method: "POST" });

    expect(response.status).toBe(200);
    expect(ensureGatewayAgent).toHaveBeenCalledWith({
      organizationId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
    });
    expect(await response.json()).toEqual({
      success: true,
      data: {
        agent: { agent_id: "00000000-0000-4000-8000-000000000003" },
        created: false,
      },
    });
  });

  test("returns the canonical typed quota response when admission is full", async () => {
    ensureGatewayAgent.mockRejectedValueOnce(
      new AgentQuotaExceededError(20, 20),
    );

    const response = await app.request("/", { method: "POST" });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(await response.json()).toEqual({
      success: false,
      error:
        "Agent quota exceeded: your organization already has 20 active agents (limit 20). Delete or stop an agent, or add credits to raise the limit.",
      code: "agent_quota_exceeded",
      details: {
        currentAgents: 20,
        maxAgents: 20,
      },
    });
    expect(toCompatAgent).not.toHaveBeenCalled();
  });
});
