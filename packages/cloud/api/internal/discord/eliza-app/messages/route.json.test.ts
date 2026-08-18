/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const routeDiscordMessage = mock(async () => ({
  handled: true,
  reason: "ok",
}));

mock.module("../../../_auth", () => ({
  requireInternalAuth: async () => ({ service: "discord-gateway" }),
}));

mock.module("@/lib/services/agent-gateway-router", () => ({
  agentGatewayRouterService: { routeDiscordMessage },
}));

mock.module("@/lib/services/managed-discord-guild-voice", () => ({
  authorizeManagedDiscordGuildVoice: async () => ({ allowed: false }),
  runManagedDiscordGuildTextTurn: async () => ({}),
}));

mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedRuntimeWorkerRequestContext: () => ({
    error: "unused",
    code: "unused",
    retryable: false,
    status: 503,
  }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined, info: () => undefined },
}));

mock.module("../../../eliza-app/personal-shared/messages/route", () => ({
  default: {
    request: async () =>
      new Response(JSON.stringify({ success: false, error: "unused" }), {
        status: 500,
      }),
  },
}));

const { default: app } = await import("./route");

const validBody = {
  guildId: "guild-1",
  channelId: "chan-1",
  messageId: "msg-1",
  content: "hello",
  sender: { id: "user-1", username: "demo" },
};

describe("POST /api/internal/discord/eliza-app/messages malformed JSON", () => {
  test("returns 400 instead of 500 and never routes a message", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(routeDiscordMessage).not.toHaveBeenCalled();
  });

  test("canonical JSON still routes a linked guild message", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(response.status).toBe(200);
    expect(routeDiscordMessage).toHaveBeenCalled();
  });
});
