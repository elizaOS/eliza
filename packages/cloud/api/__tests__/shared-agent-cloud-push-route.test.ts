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
    agentKind: "personal",
    createdAt: new Date(),
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

test("unregisters a body token without placing the device identifier in the URL", async () => {
  coordinateSharedPushUnregister.mockResolvedValue(true);
  const response = await request("notifications/push-tokens", {
    method: "DELETE",
    body: JSON.stringify({ token: "tok/with+slash" }),
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true });
  expect(coordinateSharedPushUnregister).toHaveBeenCalledWith(
    agentId,
    "tok/with+slash",
    { namespace },
  );
});

test("a shipped path-based client can register and later revoke its token", async () => {
  const tokens = new Set<string>();
  coordinateSharedPushRegister.mockImplementation(
    async (_agentId: string, registration: { token: string }) => {
      tokens.add(registration.token);
    },
  );
  coordinateSharedPushUnregister.mockImplementation(
    async (_agentId: string, token: string) => tokens.delete(token),
  );
  const token = "legacy/device+token";

  const registration = await request("notifications/push-tokens", {
    method: "POST",
    body: JSON.stringify({ platform: "ios", token }),
  });
  expect(registration.status).toBe(201);
  expect(tokens.has(token)).toBe(true);

  const revocation = await request(
    `notifications/push-tokens/${encodeURIComponent(token)}`,
    { method: "DELETE" },
  );
  expect(revocation.status).toBe(200);
  await expect(revocation.json()).resolves.toEqual({ ok: true });
  expect(tokens.has(token)).toBe(false);
});

test("rejects Android registration until Shared has an FCM sender", async () => {
  const response = await request("notifications/push-tokens", {
    method: "POST",
    body: JSON.stringify({ platform: "android", token: "fcm-token" }),
  });
  expect(response.status).toBe(400);
  expect(coordinateSharedPushRegister).not.toHaveBeenCalled();
});

test("does not expose agent-wide push registration on ordinary shared agents", async () => {
  resolveSharedAgent.mockResolvedValue({
    agent: { id: agentId, execution_tier: "shared" },
    agentId,
    orgId: "org-1",
    agentName: "Team Eliza",
  });
  const response = await request("notifications/push-tokens", {
    method: "POST",
    body: JSON.stringify({ platform: "ios", token: "device-token" }),
  });
  expect(response.status).toBe(404);
  expect(coordinateSharedPushRegister).not.toHaveBeenCalled();
});

test("does not expose legacy token revocation on ordinary shared agents", async () => {
  resolveSharedAgent.mockResolvedValue({
    agent: { id: agentId, execution_tier: "shared" },
    agentId,
    orgId: "org-1",
    agentName: "Team Eliza",
  });
  const response = await request("notifications/push-tokens/private-token", {
    method: "DELETE",
  });
  expect(response.status).toBe(404);
  expect(coordinateSharedPushUnregister).not.toHaveBeenCalled();
});

test("rejects invalid registration before durable mutation", async () => {
  const response = await request("notifications/push-tokens", {
    method: "POST",
    body: JSON.stringify({ platform: "web", token: "x" }),
  });
  expect(response.status).toBe(400);
  expect(coordinateSharedPushRegister).not.toHaveBeenCalled();
});

test("rejects a token above the durable registration limit", async () => {
  const response = await request("notifications/push-tokens", {
    method: "POST",
    body: JSON.stringify({ platform: "ios", token: "x".repeat(4_097) }),
  });
  expect(response.status).toBe(400);
  expect(coordinateSharedPushRegister).not.toHaveBeenCalled();
});

test("accepts exact-limit registration and body revocation", async () => {
  const token = "x".repeat(4_096);
  const registration = await request("notifications/push-tokens", {
    method: "POST",
    body: JSON.stringify({ platform: "ios", token }),
  });
  expect(registration.status).toBe(201);
  expect(coordinateSharedPushRegister).toHaveBeenCalledWith(
    agentId,
    { platform: "ios", token },
    expect.anything(),
  );

  coordinateSharedPushUnregister.mockResolvedValueOnce(true);
  const revocation = await request("notifications/push-tokens", {
    method: "DELETE",
    body: JSON.stringify({ token }),
  });
  expect(revocation.status).toBe(200);
  expect(coordinateSharedPushUnregister).toHaveBeenCalledWith(
    agentId,
    token,
    expect.anything(),
  );
});

test("rejects body revocation above the durable token limit", async () => {
  const response = await request("notifications/push-tokens", {
    method: "DELETE",
    body: JSON.stringify({ token: "x".repeat(4_097) }),
  });
  expect(response.status).toBe(400);
  expect(coordinateSharedPushUnregister).not.toHaveBeenCalled();
});

test("rejects path revocation above the durable token limit", async () => {
  const response = await request(
    `notifications/push-tokens/${"x".repeat(4_097)}`,
    { method: "DELETE" },
  );
  expect(response.status).toBe(400);
  expect(coordinateSharedPushUnregister).not.toHaveBeenCalled();
});

test("rejects an oversized registration body before parsing or mutation", async () => {
  const response = await request("notifications/push-tokens", {
    method: "POST",
    body: JSON.stringify({ platform: "ios", token: "x".repeat(8_192) }),
  });
  expect(response.status).toBe(413);
  expect(coordinateSharedPushRegister).not.toHaveBeenCalled();
});

test("rejects an oversized body revocation before durable mutation", async () => {
  const response = await request("notifications/push-tokens", {
    method: "DELETE",
    body: JSON.stringify({ token: "x".repeat(8_192) }),
  });
  expect(response.status).toBe(413);
  expect(coordinateSharedPushUnregister).not.toHaveBeenCalled();
});

test("rejects a declared oversized body revocation before reading JSON", async () => {
  const response = await request("notifications/push-tokens", {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": "8193",
    },
    body: "{}",
  });
  expect(response.status).toBe(413);
  expect(coordinateSharedPushUnregister).not.toHaveBeenCalled();
});
