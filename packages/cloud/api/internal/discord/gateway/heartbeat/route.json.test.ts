/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const updateHeartbeatBatch = mock(async () => 1);
const updateStats = mock(async () => undefined);

mock.module("../../../_auth", () => ({
  requireInternalAuth: async () => ({
    podName: "pod-1",
    service: "discord-gateway",
  }),
}));

mock.module("@/db/repositories/discord-connections", () => ({
  discordConnectionsRepository: {
    updateHeartbeatBatch,
    updateStats,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined, info: () => undefined },
}));

const { default: app } = await import("./route");

const validBody = {
  pod_name: "pod-1",
  connection_ids: [],
  connection_stats: [],
};

describe("POST /api/internal/discord/gateway/heartbeat malformed JSON", () => {
  test("returns 400 instead of 500 and never writes a heartbeat", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(updateHeartbeatBatch).not.toHaveBeenCalled();
  });

  test("canonical JSON still writes a heartbeat", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(response.status).toBe(200);
    expect(updateHeartbeatBatch).toHaveBeenCalled();
  });
});
