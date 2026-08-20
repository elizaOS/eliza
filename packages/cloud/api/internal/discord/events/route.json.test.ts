/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const routeDiscordEvent = mock(async () => ({ routed: true }));

mock.module("../../_auth", () => ({
  requireInternalAuth: async () => ({ service: "discord-gateway" }),
}));

mock.module("@/lib/services/gateway-discord/event-router", () => ({
  routeDiscordEvent,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined, info: () => undefined },
}));

const { default: app } = await import("./route");

const validBody = {
  connection_id: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
  platform_connection_id: "pc-1",
  event_type: "MESSAGE_CREATE",
  event_id: "evt-1",
  guild_id: "guild-1",
  channel_id: "chan-1",
  data: {},
  timestamp: "2026-08-18T00:00:00.000Z",
};

describe("POST /api/internal/discord/events malformed JSON", () => {
  test("returns 400 instead of 500 and never routes an event", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(routeDiscordEvent).not.toHaveBeenCalled();
  });

  test("canonical JSON still routes an event", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(response.status).toBe(200);
    expect(routeDiscordEvent).toHaveBeenCalled();
  });
});
