import { describe, expect, it } from "bun:test";
import { DiscordInstallWelcomeQueue } from "../src/discord-install-welcome-queue";
import { upstashLikeRedis } from "./helpers/upstash-like-redis";

describe("Discord install welcome queue on a deserializing Redis client", () => {
  it("sends the welcome for a job the client returns already parsed", async () => {
    const sent: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/users/@me/channels"))
        return Response.json({ id: "dm-1" });
      sent.push(JSON.parse(String(init?.body)).content);
      return Response.json({ id: "message-1" });
    }) as typeof fetch;
    const queue = new DiscordInstallWelcomeQueue(
      upstashLikeRedis(),
      "token",
      fetchImpl,
    );
    await queue.enqueue({
      id: "install-1",
      eventTimestamp: "2026-10-10T10:00:00.000Z",
      user: { id: "42", globalName: "Zoë ﬁnch" },
    });

    expect(await queue.drainOnce()).toBe(true);
    expect(sent).toEqual([
      "Hey Zoë ﬁnch — Eliza here. You're connected. Send me a message here and I'll reply.",
    ]);
    expect(await queue.drainOnce()).toBe(false);
  });
});
