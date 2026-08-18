/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const hasRecentHeartbeat = mock(async () => false);
const reassignFromDeadPod = mock(async () => 2);

mock.module("../../../_auth", () => ({
  requireInternalAuth: async () => ({
    podName: "pod-1",
    service: "discord-gateway",
  }),
}));

mock.module("@/db/repositories/discord-connections", () => ({
  discordConnectionsRepository: {
    hasRecentHeartbeat,
    reassignFromDeadPod,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined, info: () => undefined },
}));

const { default: app } = await import("./route");

const validBody = {
  claiming_pod: "discord-gateway-new",
  dead_pod: "discord-gateway-old",
};

describe("POST /api/internal/discord/gateway/failover malformed JSON", () => {
  test("returns 400 instead of 500 and never reassigns", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(reassignFromDeadPod).not.toHaveBeenCalled();
  });

  test("canonical JSON still reassigns from the dead pod", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(response.status).toBe(200);
    expect(reassignFromDeadPod).toHaveBeenCalled();
  });
});
