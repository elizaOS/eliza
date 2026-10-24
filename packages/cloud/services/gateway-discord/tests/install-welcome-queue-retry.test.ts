import { describe, expect, it } from "bun:test";
import {
  DISCORD_WELCOME_PENDING,
  DISCORD_WELCOME_PROCESSING,
} from "@elizaos/cloud-services-common/discord-welcome-state";
import { DiscordInstallWelcomeQueue } from "../src/discord-install-welcome-queue";
import { upstashLikeRedis } from "./helpers/upstash-like-redis";

const job = {
  id: "install-1",
  eventTimestamp: "2026-10-10T10:00:00.000Z",
  user: { id: "42", globalName: "Zoë" },
};

function failingDiscord(status: number, body: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(new URL(String(input)).pathname);
    return Response.json(body, { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("Discord install welcome delivery failures", () => {
  it("drops a job Discord rejects for good instead of retrying it every second", async () => {
    const redis = upstashLikeRedis();
    // 50007: the user blocked the bot or closed their DMs.
    const discord = failingDiscord(403, {
      message: "Cannot send messages to this user",
      code: 50007,
    });
    const queue = new DiscordInstallWelcomeQueue(
      redis,
      "token",
      discord.fetchImpl,
    );
    await queue.enqueue(job);

    expect(await queue.drainOnce()).toBe(true);
    expect(discord.calls).toEqual(["/api/v10/users/@me/channels"]);
    expect(await queue.drainOnce()).toBe(false);
    expect(discord.calls).toHaveLength(1);
    expect(redis.lists.get(DISCORD_WELCOME_PENDING) ?? []).toEqual([]);
    expect(redis.lists.get(DISCORD_WELCOME_PROCESSING) ?? []).toEqual([]);
  });

  it("retries a transient failure with backoff and gives up after the attempt budget", async () => {
    const redis = upstashLikeRedis();
    const discord = failingDiscord(502, { message: "Bad Gateway" });
    let now = Date.parse("2026-10-10T10:00:00.000Z");
    const queue = new DiscordInstallWelcomeQueue(
      redis,
      "token",
      discord.fetchImpl,
      () => now,
    );
    await queue.enqueue(job);

    expect(await queue.drainOnce()).toBe(true);
    expect(discord.calls).toHaveLength(1);
    // The next tick, one second later, must not call Discord again.
    now += 1_000;
    await queue.drainOnce();
    expect(discord.calls).toHaveLength(1);

    let attempts = 1;
    while (redis.lists.get(DISCORD_WELCOME_PENDING)?.length) {
      now += 10 * 60 * 1_000;
      await queue.drainOnce();
      attempts++;
      expect(discord.calls).toHaveLength(Math.min(attempts, 8));
      expect(attempts).toBeLessThanOrEqual(8);
    }
    expect(attempts).toBe(8);
    expect(await queue.drainOnce()).toBe(false);
    expect(discord.calls).toHaveLength(8);
    expect(redis.lists.get(DISCORD_WELCOME_PROCESSING) ?? []).toEqual([]);
  });
});
