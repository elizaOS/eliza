/**
 * Exercises the real OAUTH action's incremental-consent handoff while the
 * tenant lookup and OAuth service are deterministic boundary doubles.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import * as realOAuthModule from "../../../services/oauth";
import * as realUtils from "../utils";

const realOAuthExports = { ...realOAuthModule };
const realUtilsExports = { ...realUtils };
const initiateAuth = mock(async (_input: unknown) => ({
  authUrl: "https://accounts.example/authorize",
  state: "state-1",
  capabilityAccess: [
    {
      capabilityId: "google.calendar.write",
      status: "needs_review" as const,
      missingScopes: ["calendar.write"],
      missingUserScopes: [],
    },
  ],
  retryAfterConsent: true,
}));
let connections: Array<Record<string, unknown>> = [];

function connection(id: string, platformUserId: string): Record<string, unknown> {
  return {
    id,
    status: "active",
    platform: "google",
    platformUserId,
    userId: "user-1",
    connectionRole: "owner",
    scopes: ["identity"],
    linkedAt: new Date("2026-01-01T00:00:00.000Z"),
    source: "platform_credentials",
  };
}

mock.module("../../../services/oauth", () => ({
  oauthService: {
    isPlatformConnected: async () => true,
    listConnections: async () => connections,
    initiateAuth,
  },
}));

mock.module("../utils", () => ({
  ...realUtilsExports,
  getSupportedPlatforms: () => ["google"],
  isSupportedPlatform: (platform: string) => platform === "google",
  lookupUser: async () => ({
    organizationId: "org-1",
    user: { id: "user-1", organization_id: "org-1" },
  }),
}));

const { oauthAction } = await import("./oauth");

afterAll(() => {
  mock.module("../../../services/oauth", () => realOAuthExports);
  mock.module("../utils", () => realUtilsExports);
});

function message(actionParams: Record<string, unknown> = {}): Memory {
  return {
    agentId: "agent-1",
    entityId: "user-1",
    roomId: "room-1",
    content: {
      text: "I need calendar write access",
      actionParams: {
        op: "connect",
        platform: "google",
        capabilities: ["google.calendar.write"],
        redirectUrl: "/calendar?retry=intent-1",
        ...actionParams,
      },
    },
  } as Memory;
}

describe("OAUTH incremental capability handoff (#19879)", () => {
  beforeEach(() => {
    initiateAuth.mockClear();
    connections = [connection("11111111-1111-4111-8111-111111111111", "google-user-1")];
  });

  test("extends the active account and returns machine-readable retry state", async () => {
    const result = await oauthAction.handler({} as IAgentRuntime, message());

    expect(initiateAuth).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      platform: "google",
      redirectUrl: "/calendar?retry=intent-1",
      scopes: undefined,
      capabilities: ["google.calendar.write"],
      connectionId: "11111111-1111-4111-8111-111111111111",
      connectionRole: "owner",
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      actionName: "OAUTH",
      op: "connect",
      connectionId: "11111111-1111-4111-8111-111111111111",
      retryAfterConsent: true,
      capabilityAccess: [
        {
          capabilityId: "google.calendar.write",
          status: "needs_review",
        },
      ],
    });
  });

  test("requires an explicit account when multiple active connections exist", async () => {
    connections.push(connection("22222222-2222-4222-8222-222222222222", "google-user-2"));

    const result = await oauthAction.handler({} as IAgentRuntime, message());

    expect(result).toMatchObject({
      success: false,
      error: "AMBIGUOUS_CONNECTION",
    });
    expect(initiateAuth).not.toHaveBeenCalled();
  });

  test("binds the explicitly selected account when multiple are active", async () => {
    connections.push(connection("22222222-2222-4222-8222-222222222222", "google-user-2"));

    const result = await oauthAction.handler(
      {} as IAgentRuntime,
      message({ connectionId: "22222222-2222-4222-8222-222222222222" }),
    );

    expect(result.success).toBe(true);
    expect(initiateAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "22222222-2222-4222-8222-222222222222",
      }),
    );
  });
});
