/** Exercises both gateway facades over real HTTP and their distinct route-unavailability contracts. */

import { afterEach, describe, expect, test } from "bun:test";
import {
  forwardToServer as forwardDiscord,
  resolveAgentServer as resolveDiscord,
} from "../../gateway-discord/src/server-router";
import {
  forwardToServer as forwardWebhook,
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
        return Response.json({ response: "agent completed the turn" });
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
    ).resolves.toBe("agent completed the turn");
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
});
