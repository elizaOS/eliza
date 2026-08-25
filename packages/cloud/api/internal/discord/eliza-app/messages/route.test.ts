/** Verifies that the Discord service wrapper preserves Personal Shared timing. */

import { beforeEach, expect, mock, test } from "bun:test";
import { consumePreverifiedPersonalSharedRequest } from "../../../eliza-app/personal-shared/preverified-auth";

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: () => Response.json({ success: false }, { status: 500 }),
}));
mock.module("@/lib/services/agent-gateway-router", () => ({
  agentGatewayRouterService: {
    routeDiscordMessage: mock(async () => ({
      handled: false,
      reason: "not_linked",
    })),
  },
}));
mock.module("@/lib/services/managed-discord-guild-voice", () => ({
  authorizeManagedDiscordGuildVoice: mock(async () => ({ allowed: false })),
  runManagedDiscordGuildTextTurn: mock(async () => ({ replyText: "" })),
}));
mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedRuntimeWorkerRequestContext: mock(() => ({
    error: "unused",
    code: "service_unavailable",
    retryable: true,
    status: 503,
  })),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined) },
}));
const authResult: { podName: string; service: string } | Response = {
  podName: "gateway-1",
  service: "discord-gateway",
};
const requireInternalAuth = mock(async () => authResult);
mock.module("../../../_auth", () => ({ requireInternalAuth }));

const personalSharedFetch = mock(async (request: Request) => {
  expect(consumePreverifiedPersonalSharedRequest(request)).toEqual({
    podName: "gateway-1",
    service: "discord-gateway",
  });
  expect(request.headers.get("authorization")).toBeNull();
  await expect(request.json()).resolves.toEqual({
    platform: "discord",
    discordUserId: "666666666666666666",
    discordUsername: "tester",
    messageId: "discord:555555555555555555",
    message: "hello",
  });
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        identity: { id: "11111111-1111-4111-8111-111111111111" },
        account: {
          userId: "22222222-2222-4222-8222-222222222222",
          organizationId: "33333333-3333-4333-8333-333333333333",
        },
        reply: "ready",
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Server-Timing":
          'account;dur=14.2;desc="sender-projection-hit", prewarm;dur=1.1, shared;dur=472.8',
      },
    },
  );
});

mock.module("../../../eliza-app/personal-shared/messages/route", () => ({
  default: { fetch: personalSharedFetch },
}));

const { default: app } = await import("./route");
const executionCtx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};

beforeEach(() => {
  requireInternalAuth.mockClear();
  personalSharedFetch.mockClear();
});

test("forwards a first Discord DM to Personal Shared account creation", async () => {
  const response = await app.request(
    "http://localhost/",
    {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channelId: "444444444444444444",
        messageId: "555555555555555555",
        content: "hello",
        sender: { id: "666666666666666666", username: "tester" },
      }),
    },
    { INTERNAL_SECRET: "test-secret" } as never,
    executionCtx as never,
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("Server-Timing")).toMatch(
    /^discord_auth;dur=\d+\.\d, discord_validation;dur=\d+\.\d, account;dur=14\.2;desc="sender-projection-hit", prewarm;dur=1\.1, shared;dur=472\.8, discord_inner;dur=\d+\.\d, discord_wrapper;dur=\d+\.\d$/,
  );
  expect(requireInternalAuth).toHaveBeenCalledTimes(1);
  expect(personalSharedFetch).toHaveBeenCalledTimes(1);
});
