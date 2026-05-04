import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let agentGatewayRelayService: typeof import("../../lib/services/agent-gateway-relay").agentGatewayRelayService;

const createdSessionIds: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdSessionIds
      .splice(0)
      .map((sessionId) => agentGatewayRelayService.disconnectSession(sessionId)),
  );
});

beforeEach(async () => {
  mock.restore();
  ({ agentGatewayRelayService } = await import(
    new URL("../../lib/services/agent-gateway-relay.ts", import.meta.url).href
  ));
  agentGatewayRelayService.resetForTests();
});

describe("agentGatewayRelayService", () => {
  test("defers the Redis production guard until the relay is actually used", async () => {
    const env = process.env as Record<string, string | undefined>;
    const envKeys = [
      "NODE_ENV",
      "ENVIRONMENT",
      "REDIS_URL",
      "KV_URL",
      "KV_REST_API_URL",
      "KV_REST_API_TOKEN",
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
      "AGENT_ALLOW_EPHEMERAL_CLOUD_STATE",
    ] as const;
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

    try {
      env.NODE_ENV = "production";
      delete env.ENVIRONMENT;
      delete env.REDIS_URL;
      delete env.KV_URL;
      delete env.KV_REST_API_URL;
      delete env.KV_REST_API_TOKEN;
      delete env.UPSTASH_REDIS_REST_URL;
      delete env.UPSTASH_REDIS_REST_TOKEN;
      delete env.AGENT_ALLOW_EPHEMERAL_CLOUD_STATE;

      const imported = await import(
        new URL(`../../lib/services/agent-gateway-relay.ts?test=${Date.now()}`, import.meta.url)
          .href
      );

      expect(imported.agentGatewayRelayService).toBeDefined();
      imported.agentGatewayRelayService.resetForTests(null);
      await expect(
        imported.agentGatewayRelayService.listOwnerSessions("org-prod", "user-prod"),
      ).rejects.toThrow("Redis-backed shared storage is required in production");
    } finally {
      for (const key of envKeys) {
        const value = previousEnv[key];
        if (value === undefined) {
          delete env[key];
        } else {
          env[key] = value;
        }
      }
    }
  });

  test("queues a request for a registered local session and resolves the posted response", async () => {
    const session = await agentGatewayRelayService.registerSession({
      organizationId: "org-1",
      userId: "user-1",
      runtimeAgentId: "local-agent-1",
      agentName: "Local Agent",
    });
    createdSessionIds.push(session.id);

    const routePromise = agentGatewayRelayService.routeToSession(
      session,
      {
        jsonrpc: "2.0",
        id: "rpc-1",
        method: "message.send",
        params: { text: "hello from cloud" },
      },
      2_000,
    );

    const nextRequest = await agentGatewayRelayService.pollNextRequest(session.id, 500);
    expect(nextRequest).not.toBeNull();
    expect(nextRequest?.rpc.method).toBe("message.send");
    expect(nextRequest?.rpc.params?.text).toBe("hello from cloud");

    const accepted = await agentGatewayRelayService.respondToRequest({
      sessionId: session.id,
      requestId: nextRequest!.requestId,
      response: {
        jsonrpc: "2.0",
        id: "rpc-1",
        result: { text: "hello from local" },
      },
    });

    expect(accepted).toBe(true);
    await expect(routePromise).resolves.toEqual({
      jsonrpc: "2.0",
      id: "rpc-1",
      result: { text: "hello from local" },
    });
  });

  test("indexes active sessions by owner and clears them on disconnect", async () => {
    const session = await agentGatewayRelayService.registerSession({
      organizationId: "org-2",
      userId: "user-2",
      runtimeAgentId: "local-agent-2",
      agentName: "Second Local Agent",
    });
    createdSessionIds.push(session.id);

    await expect(agentGatewayRelayService.listOwnerSessions("org-2", "user-2")).resolves.toEqual([
      expect.objectContaining({
        id: session.id,
        runtimeAgentId: "local-agent-2",
      }),
    ]);

    await agentGatewayRelayService.disconnectSession(session.id);
    createdSessionIds.splice(createdSessionIds.indexOf(session.id), 1);

    await expect(agentGatewayRelayService.listOwnerSessions("org-2", "user-2")).resolves.toEqual(
      [],
    );
  });
});
