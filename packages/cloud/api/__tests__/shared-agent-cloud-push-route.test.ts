/** Drives the mounted Personal Shared push-token compatibility route with a durable coordinator seam. */

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as realCoordinator from "@/lib/services/shared-runtime/conversation-coordinator";
import * as realResolver from "@/lib/services/shared-runtime/resolve-shared-agent";

const resolveSharedAgent = mock();
const coordinateSharedPushList = mock();
const coordinateSharedPushRegister = mock();
const coordinateSharedPushUnregister = mock();
const namespace = { getByName: mock() };

mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  ...realResolver,
  resolveSharedAgent,
  resolveSharedRuntimeWorkerRequestContext: () => ({
    namespace,
    executionCtx: { waitUntil: () => undefined },
  }),
}));
mock.module("@/lib/services/shared-runtime/conversation-coordinator", () => ({
  ...realCoordinator,
  coordinateSharedPushList,
  coordinateSharedPushRegister,
  coordinateSharedPushUnregister,
}));

const route = (await import("../v1/eliza/agents/[agentId]/api/[...path]/route"))
  .default;
const app = new Hono();
app.route("/api/v1/eliza/agents/:agentId/api/:*{.+}", route);
const agentId = "cc3f37f5-f69a-4b27-9fa1-a4bd3d702136";

function request(path: string, init?: RequestInit) {
  return app.request(
    `https://api.elizacloud.ai/api/v1/eliza/agents/${agentId}/api/${path}`,
    {
      headers: { "Content-Type": "application/json" },
      ...init,
    },
  );
}

beforeEach(() => {
  resolveSharedAgent.mockReset();
  resolveSharedAgent.mockResolvedValue({
    agent: { id: agentId, execution_tier: "shared" },
    agentId,
    orgId: "org-1",
    agentName: "Eliza",
  });
  coordinateSharedPushList.mockReset();
  coordinateSharedPushRegister.mockReset();
  coordinateSharedPushUnregister.mockReset();
});

afterAll(() => {
  mock.module(
    "@/lib/services/shared-runtime/resolve-shared-agent",
    () => realResolver,
  );
  mock.module(
    "@/lib/services/shared-runtime/conversation-coordinator",
    () => realCoordinator,
  );
});

test("registers through the selected agent's durable coordinator", async () => {
  coordinateSharedPushRegister.mockResolvedValue(undefined);
  const response = await request("notifications/push-tokens", {
    method: "POST",
    body: JSON.stringify({ platform: "ios", token: "device-token" }),
  });
  expect(response.status).toBe(201);
  await expect(response.json()).resolves.toEqual({ ok: true });
  expect(coordinateSharedPushRegister).toHaveBeenCalledWith(
    agentId,
    { platform: "ios", token: "device-token" },
    { namespace },
  );
});

test("reports platform counts without returning raw tokens", async () => {
  coordinateSharedPushList.mockResolvedValue([
    { platform: "ios", token: "secret-ios", createdAt: 1 },
    { platform: "android", token: "secret-android", createdAt: 2 },
  ]);
  const response = await request("notifications/push-tokens");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ count: 2, platforms: { ios: 1, android: 1 } });
  expect(JSON.stringify(body)).not.toContain("secret-ios");
});

test("unregisters an encoded token through the same agent authority", async () => {
  coordinateSharedPushUnregister.mockResolvedValue(true);
  const response = await request(
    "notifications/push-tokens/tok%2Fwith%2Bslash",
    {
      method: "DELETE",
    },
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true });
  expect(coordinateSharedPushUnregister).toHaveBeenCalledWith(
    agentId,
    "tok/with+slash",
    { namespace },
  );
});

test("rejects invalid registration before durable mutation", async () => {
  const response = await request("notifications/push-tokens", {
    method: "POST",
    body: JSON.stringify({ platform: "web", token: "x" }),
  });
  expect(response.status).toBe(400);
  expect(coordinateSharedPushRegister).not.toHaveBeenCalled();
});

test("rejects an oversized registration body before parsing or mutation", async () => {
  const response = await request("notifications/push-tokens", {
    method: "POST",
    body: JSON.stringify({ platform: "ios", token: "x".repeat(8_192) }),
  });
  expect(response.status).toBe(413);
  expect(coordinateSharedPushRegister).not.toHaveBeenCalled();
});
