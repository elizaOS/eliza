/**
 * Verifies the managed Discord gateway does not emit visible pre-decision
 * effects for ambient guild turns. The real manager routing boundary posts the
 * turn to Cloud, while deterministic responses model downstream authorization
 * denial and runtime ignore decisions.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Message } from "discord.js";
import { GatewayManager } from "../src/gateway-manager";

const originalFetch = globalThis.fetch;
const BOT_ID = "100000000000000001";
const SENDER_ID = "200000000000000002";

interface ManagedGuildHarness {
  accessToken: string | null;
  tokenExpiresAt: Date | null;
  elizaAppClient: { user: { id: string } } | null;
  handleManagedAgentGuildMessage(message: Message): Promise<void>;
}

function createHarness() {
  const manager = new GatewayManager({
    podName: "test-pod",
    elizaCloudUrl: "https://cloud.test",
    gatewayBootstrapSecret: "test-secret",
    project: "test",
  });
  const harness = manager as unknown as ManagedGuildHarness;
  harness.accessToken = "test-token";
  harness.tokenExpiresAt = new Date(Date.now() + 60_000);
  harness.elizaAppClient = { user: { id: BOT_ID } };
  return harness;
}

function guildMessage(options: { mentionBot?: boolean } = {}) {
  let typingCalls = 0;
  let replyCalls = 0;
  const mentionedUserIds = options.mentionBot ? [BOT_ID] : [];
  const message = {
    id: "message-1",
    guildId: "guild-1",
    channelId: "channel-1",
    content: options.mentionBot ? `<@${BOT_ID}> hello` : "ambient hello",
    author: {
      id: SENDER_ID,
      username: "speaker",
      bot: false,
      globalName: "Speaker",
      displayAvatarURL: () => "",
    },
    member: { displayName: "Speaker" },
    mentions: {
      users: {
        map: (select: (user: { id: string }) => string) =>
          mentionedUserIds.map((id) => select({ id })),
      },
      repliedUser: null,
      everyone: false,
    },
    channel: {
      sendTyping: async () => {
        typingCalls += 1;
      },
    },
    reply: async () => {
      replyCalls += 1;
      return null;
    },
  } as unknown as Message;
  return {
    message,
    typingCalls: () => typingCalls,
    replyCalls: () => replyCalls,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("managed guild ambient pre-decision effects", () => {
  test.each([
    ["authorization denial", "sender_not_guild_owner"],
    ["runtime ignore", "ignored"],
  ])("%s emits no typing or reply", async (_label, reason) => {
    let routedCalls = 0;
    globalThis.fetch = mock(async () => {
      routedCalls += 1;
      return Response.json({ handled: false, reason });
    }) as typeof fetch;
    const harness = createHarness();
    const turn = guildMessage();

    await harness.handleManagedAgentGuildMessage(turn.message);

    expect(routedCalls).toBe(1);
    expect(turn.typingCalls()).toBe(0);
    expect(turn.replyCalls()).toBe(0);
  });

  test("an explicit mention retains its pre-decision typing heartbeat", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ handled: false, reason: "ignored" }),
    ) as typeof fetch;
    const harness = createHarness();
    const turn = guildMessage({ mentionBot: true });

    await harness.handleManagedAgentGuildMessage(turn.message);

    expect(turn.typingCalls()).toBe(1);
    expect(turn.replyCalls()).toBe(0);
  });
});
