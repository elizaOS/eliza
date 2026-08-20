/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const updateStatus = mock(async () => ({
  id: "11111111-1111-4111-8111-111111111111",
  status: "connected",
}));

mock.module("../../../_auth", () => ({
  requireInternalAuth: async () => ({
    podName: "pod-1",
    service: "discord-gateway",
  }),
}));

mock.module("@/db/repositories/discord-connections", () => ({
  discordConnectionsRepository: {
    updateStatus,
    findByAssignedPod: async () => [],
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined, info: () => undefined },
}));

const { default: app } = await import("./route");

const validBody = {
  connection_id: "11111111-1111-4111-8111-111111111111",
  pod_name: "pod-1",
  status: "connected",
};

describe("POST /api/internal/discord/gateway/status malformed JSON", () => {
  test("returns 400 instead of 500 and never writes status", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(updateStatus).not.toHaveBeenCalled();
  });

  test("canonical JSON still writes connection status", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(response.status).toBe(200);
    expect(updateStatus).toHaveBeenCalled();
  });
});
