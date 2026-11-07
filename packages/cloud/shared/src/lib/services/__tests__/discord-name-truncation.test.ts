import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// The automation service reads repositories at import time; the nickname path
// never touches them, so keep the database out of this test.
mock.module("../../../db/repositories/discord-channels", () => ({
  discordChannelsRepository: {},
}));
mock.module("../../../db/repositories/discord-guilds", () => ({
  discordGuildsRepository: {},
}));

const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
const realFetch = globalThis.fetch;

function isWellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

beforeAll(() => {
  process.env.DISCORD_BOT_TOKEN = "test-bot-token";
  process.env.DISCORD_CHANNEL_ID = "100000000000000001";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ id: "200000000000000002" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("Discord name limits keep surrogate pairs whole", () => {
  test("bot nickname cut at 32 does not leave half an emoji", async () => {
    const { discordAutomationService } = await import("../discord-automation");
    // 31 ASCII chars put the emoji's high surrogate at index 31, the last kept unit.
    const nickname = `${"a".repeat(31)}🎉 bot`;
    sent.length = 0;

    const ok = await discordAutomationService.setGuildBotNickname("300000000000000003", nickname);

    expect(ok).toBe(true);
    const nick = String(sent[0]?.body.nick);
    expect(isWellFormed(nick)).toBe(true);
    expect(nick).toBe("a".repeat(31));
  });

  test("thread name cut at 100 does not leave half an emoji", async () => {
    const { discordService } = await import("../discord");
    const name = `${"t".repeat(99)}🧵 follow-up`;
    sent.length = 0;

    await discordService.createThread({ name });

    const threadName = String(sent[0]?.body.name);
    expect(isWellFormed(threadName)).toBe(true);
    expect(threadName).toBe("t".repeat(99));
  });

  test("names under the limit are sent unchanged", async () => {
    const { discordAutomationService } = await import("../discord-automation");
    sent.length = 0;

    await discordAutomationService.setGuildBotNickname("300000000000000003", "Eliza 🎉");

    expect(sent[0]?.body.nick).toBe("Eliza 🎉");
  });

  test("embed text fields cut at 200 do not leave half an emoji", async () => {
    const { discordService } = await import("../discord");
    // 199 ASCII chars put the emoji's high surrogate at index 199, the last kept unit.
    const long = `${"p".repeat(199)}🎬 and more`;
    const expected = `${"p".repeat(199)}...`;
    const base = { userId: "u-1", organizationId: "o-1", organizationName: "Org" };
    const fieldOf = (name: string) => {
      const embeds = sent[0]?.body.embeds as Array<{
        fields: Array<{ name: string; value: string }>;
      }>;
      return String(embeds[0].fields.find((f) => f.name === name)?.value);
    };
    const cases: Array<[string, () => Promise<boolean>]> = [
      [
        "Prompt",
        () =>
          discordService.logVideoGenerated({
            ...base,
            generationId: "g-1",
            prompt: long,
            videoUrl: "https://cdn.local/v1.mp4",
          }),
      ],
      [
        "Prompt",
        () =>
          discordService.logImageGenerated({
            ...base,
            generationId: "g-2",
            prompt: long,
            imageUrl: "https://cdn.local/i2.png",
            numImages: 1,
          }),
      ],
      [
        "Description",
        () =>
          discordService.logAppCreated({
            ...base,
            appId: "a-1",
            appName: "App",
            slug: "app",
            appUrl: "https://app.local",
            description: long,
          }),
      ],
      [
        "Bio",
        () =>
          discordService.logCharacterCreated({
            ...base,
            characterId: "c-1",
            characterName: "Eliza",
            bio: long,
          }),
      ],
    ];
    for (const [name, run] of cases) {
      sent.length = 0;
      await run();
      const value = fieldOf(name);
      expect(isWellFormed(value)).toBe(true);
      expect(value).toBe(expected);
    }
  });
});
