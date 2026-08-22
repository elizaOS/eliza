/**
 * Exercises Telegram group-link authority lookup against provider-shaped
 * updates for every Cloud-accepted command syntax and failure boundary.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { telegramAdapter } from "../src/adapters/telegram";

const originalFetch = globalThis.fetch;
const config = {
  botToken: "telegram-test-token",
  botUsername: "ElizaBot",
};

function groupUpdate(text: string, botCommandLength?: number): string {
  return JSON.stringify({
    update_id: 7001,
    message: {
      message_id: 88,
      date: 1_786_283_200,
      from: { id: 42, first_name: "Ada", is_bot: false },
      chat: { id: -100123456789, type: "supergroup" },
      text,
      ...(botCommandLength
        ? {
            entities: [
              { type: "bot_command", offset: 0, length: botCommandLength },
            ],
          }
        : {}),
    },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("telegram group-link authority", () => {
  test.each([
    ["slash", "/eliza_link 23456789"],
    ["natural language", "Eliza link 23456789"],
    ["bot-suffixed slash", "/eliza_link@ElizaBot 23456789"],
    ["trimmed slash", "  /eliza_link 23456789\n"],
    ["trimmed natural language", "\tEliza link 23456789  "],
    ["trimmed bot-suffixed slash", "\n/eliza_link@ElizaBot 23456789\t"],
  ])("verifies %s syntax through current membership", async (_case, text) => {
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        ok: true,
        result: { status: "administrator" },
      });
    }) as typeof fetch;

    const commandLength = text.startsWith("/") ? text.indexOf(" ") : undefined;
    const event = await telegramAdapter.extractEvent(
      groupUpdate(text, commandLength),
      config,
    );

    expect(event).toMatchObject({
      chatId: "-100123456789",
      senderId: "42",
      text,
      groupActorRole: "administrator",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toEndWith("/getChatMember");
    await expect(requests[0]?.json()).resolves.toEqual({
      chat_id: "-100123456789",
      user_id: "42",
    });
  });

  test("does not perform a membership lookup for a non-link message", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json({ ok: true, result: {} });
    }) as typeof fetch;

    const event = await telegramAdapter.extractEvent(
      groupUpdate("hello group"),
      config,
    );

    expect(event).toMatchObject({ text: "hello group" });
    expect(event?.groupActorRole).toBeUndefined();
    expect(requests).toBe(0);
  });

  test("drops a link command addressed to another bot", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json({ ok: true, result: { status: "creator" } });
    }) as typeof fetch;
    const text = "/eliza_link@OtherBot 23456789";

    const event = await telegramAdapter.extractEvent(
      groupUpdate(text, text.indexOf(" ")),
      config,
    );

    expect(event).toBeNull();
    expect(requests).toBe(0);
  });

  test.each([
    ["ambient", "  /eliza_ambient@OtherBot on\n"],
    ["leave", "\t/eliza_leave@OtherBot  "],
  ])(
    "drops a foreign %s command at the adapter boundary",
    async (_case, text) => {
      let requests = 0;
      globalThis.fetch = (async () => {
        requests += 1;
        return Response.json({ ok: true, result: {} });
      }) as typeof fetch;

      const event = await telegramAdapter.extractEvent(
        groupUpdate(text),
        config,
      );

      expect(event).toBeNull();
      expect(requests).toBe(0);
    },
  );

  test("drops a whitespace-padded link command addressed to another bot", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return Response.json({ ok: true, result: { status: "creator" } });
    }) as typeof fetch;
    const text = "  /eliza_link@OtherBot 23456789\n";

    const event = await telegramAdapter.extractEvent(groupUpdate(text), config);

    expect(event).toBeNull();
    expect(requests).toBe(0);
  });

  test("drops a suffixed link command when bot identity is unavailable", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      throw new Error("Telegram unavailable");
    }) as typeof fetch;
    const text = " \t/eliza_link@ElizaBot 23456789\n";

    const event = await telegramAdapter.extractEvent(groupUpdate(text), {
      botToken: "telegram-test-token",
    });

    expect(event).toBeNull();
    expect(requests).toBe(1);
  });

  test("fails a link command closed when current membership lookup fails", async () => {
    globalThis.fetch = (async () => {
      throw new Error("Telegram unavailable");
    }) as typeof fetch;

    const event = await telegramAdapter.extractEvent(
      groupUpdate("Eliza link 23456789"),
      config,
    );

    expect(event).toMatchObject({
      chatId: "-100123456789",
      senderId: "42",
      groupActorRole: "unknown",
    });
  });

  test("preserves the event with unknown authority when Telegram rejects membership lookup", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        {
          ok: false,
          error_code: 403,
          description: "Forbidden: bot is not a member of the supergroup",
        },
        { status: 403 },
      )) as typeof fetch;

    const event = await telegramAdapter.extractEvent(
      groupUpdate("/eliza_link 23456789", "/eliza_link".length),
      config,
    );

    expect(event).toMatchObject({
      chatId: "-100123456789",
      senderId: "42",
      text: "/eliza_link 23456789",
      groupActorRole: "unknown",
    });
  });
});
