/** Exercises both gateway facades over real HTTP and their distinct route-unavailability contracts. */

import { afterEach, describe, expect, test } from "bun:test";
import {
  forwardToServer as forwardDiscord,
  resolveAgentServer as resolveDiscord,
} from "../../gateway-discord/src/server-router";
import {
  forwardToServer as forwardWebhook,
  forwardEventToServer as forwardWebhookEvent,
  type RoutingRedis,
  resolveAgentServer as resolveWebhook,
} from "../src/server-router";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("gateway routing facade conformance", () => {
  test("forwards both host payloads through the common HTTP mechanism", async () => {
    const messages: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        messages.push((await request.json()) as Record<string, unknown>);
        return Response.json({
          response: "agent completed the turn",
          mediaUrls: ["https://cdn.example.com/cat.png"],
        });
      },
    });
    servers.push(server);
    await expect(
      forwardDiscord(
        server.url.origin,
        "direct",
        "test-agent",
        "user-1",
        "hello discord",
        { platformRecordId: "discord-1" },
      ),
    ).resolves.toBe("agent completed the turn");
    await expect(
      forwardWebhook(
        server.url.origin,
        "direct",
        "test-agent",
        "user-1",
        "hello telegram",
        { platformName: "telegram", platformRecordId: "telegram-1" },
      ),
    ).resolves.toEqual({
      text: "agent completed the turn",
      mediaUrls: ["https://cdn.example.com/cat.png"],
    });
    expect(messages).toEqual([
      {
        userId: "user-1",
        text: "hello discord",
        platformName: "discord",
        platformRecordId: "discord-1",
      },
      {
        userId: "user-1",
        text: "hello telegram",
        platformName: "telegram",
        platformRecordId: "telegram-1",
      },
    ]);
  });

  test("keeps webhook unregistered versus unreachable distinct while Discord preserves null", async () => {
    const values = new Map<string, string>();
    const redis: RoutingRedis = {
      get: async <T = string>(key: string) =>
        (values.get(key) ?? null) as T | null,
      set: async () => "OK",
      lpush: async () => 1,
      ltrim: async () => "OK",
      expire: async () => 1,
    };
    expect(await resolveDiscord(redis, "agent-1")).toBeNull();
    expect(await resolveWebhook(redis, "agent-1")).toEqual({
      kind: "unregistered",
    });
    values.set("agent:agent-1:server", "server-1");
    expect(await resolveDiscord(redis, "agent-1")).toBeNull();
    expect(await resolveWebhook(redis, "agent-1")).toEqual({
      kind: "unreachable",
      serverName: "server-1",
    });
    values.set("server:server-1:url", "http://registered.example");
    expect(await resolveDiscord(redis, "agent-1")).toEqual({
      serverName: "server-1",
      serverUrl: "http://registered.example",
    });
    expect(await resolveWebhook(redis, "agent-1")).toEqual({
      kind: "ready",
      serverName: "server-1",
      serverUrl: "http://registered.example",
    });
  });

  test("does not send a final canonical ingress answer again to the registered sandbox target", async () => {
    const agentId = "1f0e8a52-7c3d-4b9a-8e21-5d6c7b8a9f01";
    const canonicalOrigin = "https://eliza-staging-1.eliza.app";
    const registeredPosts: string[] = [];
    const registered = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        registeredPosts.push(new URL(request.url).pathname);
        return Response.json({ response: "registered target answered" });
      },
    });
    servers.push(registered);
    const canonicalPosts: string[] = [];
    let canonicalStatus = 500;
    const originalFetch = globalThis.fetch;
    const originalEnv = {
      AGENT_ROUTER_ORIGIN_HOST: process.env.AGENT_ROUTER_ORIGIN_HOST,
      ELIZA_CLOUD_AGENT_BASE_DOMAIN: process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
    };
    process.env.AGENT_ROUTER_ORIGIN_HOST = "eliza-staging-1.eliza.app";
    process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = "cloud-staging.eliza.app";
    // The canonical router host is fixed, so only its requests are answered
    // here; the registered target stays a real loopback server.
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.startsWith(canonicalOrigin)) return originalFetch(input, init);
        canonicalPosts.push(new URL(url).pathname);
        return new Response(`canonical answered ${canonicalStatus}`, {
          status: canonicalStatus,
        });
      },
      originalFetch,
    );
    try {
      await expect(
        forwardWebhook(
          registered.url.origin,
          "sandbox-1",
          agentId,
          "user-1",
          "hello",
        ),
      ).rejects.toThrow("Server returned 500: canonical answered 500");
      canonicalStatus = 400;
      await expect(
        forwardWebhookEvent(
          registered.url.origin,
          "sandbox-1",
          agentId,
          "user-1",
          "system",
          {},
        ),
      ).rejects.toThrow("Server returned 400: canonical answered 400");
      expect(canonicalPosts).toEqual([
        `/api/agents/${agentId}/message`,
        `/api/agents/${agentId}/event`,
      ]);
      expect(registeredPosts).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
