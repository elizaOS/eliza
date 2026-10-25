import { describe, expect, it } from "bun:test";
import { deliverInternalDiscordMessage } from "../src/internal-delivery";
import { createMockRedis } from "../src/redis-adapter";

describe("internal Discord delivery replay", () => {
  it("replays a completed delivery whose receipt the Redis adapter returns parsed", async () => {
    const redis = createMockRedis();
    let sends = 0;
    // Same wiring as src/index.ts: receipts are read through the gateway Redis adapter.
    const deps = {
      getInternalSecret: () => "s3cret",
      receipts: {
        get: (key: string) => redis.get<string>(key),
        set: (
          key: string,
          value: string,
          options: { ex: number; nx?: boolean },
        ) => redis.set(key, value, options),
        delete: (key: string) => redis.del(key),
      },
      sendDirectMessage: async () => {
        sends += 1;
        return { accepted: true as const, providerMessageId: "1234567890" };
      },
    };
    const request = () =>
      new Request("http://gateway/internal/deliver", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Internal-Secret": "s3cret",
        },
        body: JSON.stringify({
          platform: "discord",
          discordUserId: "42",
          text: "Rappel : réunion à 9 h",
          idempotencyKey: "reminder-1",
        }),
      });

    expect((await deliverInternalDiscordMessage(request(), deps)).status).toBe(
      200,
    );
    const replay = await deliverInternalDiscordMessage(request(), deps);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      success: true,
      replayed: true,
      providerMessageIds: ["1234567890"],
    });
    expect(sends).toBe(1);
  });
});
