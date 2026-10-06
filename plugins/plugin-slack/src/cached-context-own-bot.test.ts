/**
 * Cached Slack chat context attributes this account's own bot messages to the
 * agent, matching stored history (`slackMessageToMemory`), while other bots
 * and humans keep their existing connector mapping. Driven against a real
 * `getConnectorChatContext` with only the Slack API surface stubbed.
 */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { normalizeAccountId } from "./accounts.ts";
import { SlackService } from "./service.ts";
import type { SlackChannel, SlackMessage, SlackUser } from "./types.ts";

const ACCOUNT_ID = "acct-1";
const CHANNEL_ID = "C12345678";
const BOT_USER_ID = "B0AGENT";
const OTHER_BOT_ID = "B0OTHER";
const HUMAN_ID = "U123HUMAN";

function slackMessage(
  overrides: Partial<SlackMessage> & { ts: string; text: string },
): SlackMessage {
  return {
    type: "message",
    subtype: undefined,
    ts: overrides.ts,
    user: undefined,
    text: overrides.text,
    threadTs: undefined,
    replyCount: undefined,
    replyUsersCount: undefined,
    latestReply: undefined,
    reactions: undefined,
    files: undefined,
    attachments: undefined,
    blocks: undefined,
    ...overrides,
  };
}

function createRuntime(agentId: UUID) {
  const runtime = {
    agentId,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRoom: vi.fn(),
  };
  return runtime as unknown as IAgentRuntime;
}

function createService(runtime: IAgentRuntime, messages: SlackMessage[]) {
  return Object.assign(Object.create(SlackService.prototype) as SlackService, {
    runtime,
    defaultAccountId: ACCOUNT_ID,
    accountStates: new Map([
      [
        normalizeAccountId(ACCOUNT_ID),
        {
          accountId: ACCOUNT_ID,
          account: { accountId: ACCOUNT_ID, name: "A" },
          teamId: "TA",
          botUserId: BOT_USER_ID,
          client: {},
        },
      ],
    ]),
    resolveAccountIdForTarget: vi.fn(async () => ACCOUNT_ID),
    getChannel: vi.fn(
      async () => ({ id: CHANNEL_ID, name: "general" }) as SlackChannel,
    ),
    readHistory: vi.fn(async () => messages),
    getUser: vi.fn(async (userId: string) =>
      userId === HUMAN_ID
        ? ({
            id: HUMAN_ID,
            name: "human",
            profile: { displayName: "Human" },
          } as unknown as SlackUser)
        : null,
    ),
  });
}

describe("Slack cached chat context author attribution", () => {
  it("maps this account's bot to the agent and keeps other authors mapped", async () => {
    const agentId = "11111111-1111-4111-8111-111111111111" as UUID;
    const runtime = createRuntime(agentId);
    const service = createService(runtime, [
      slackMessage({ ts: "1700000003.000001", user: HUMAN_ID, text: "hello" }),
      slackMessage({
        ts: "1700000002.000001",
        subtype: "bot_message",
        botId: OTHER_BOT_ID,
        text: "other bot reply",
      }),
      slackMessage({
        ts: "1700000001.000001",
        subtype: "bot_message",
        botId: BOT_USER_ID,
        text: "agent reply via bot id",
      }),
      slackMessage({
        ts: "1700000000.000001",
        user: BOT_USER_ID,
        text: "agent reply via user",
      }),
    ]);

    const context = await service.getConnectorChatContext(
      { channelId: CHANNEL_ID } as never,
      { runtime, accountId: ACCOUNT_ID } as never,
    );

    const byText = new Map(
      (context?.recentMessages ?? []).map((message) => [message.text, message]),
    );
    expect(byText.get("agent reply via bot id")?.entityId).toBe(agentId);
    expect(byText.get("agent reply via user")?.entityId).toBe(agentId);
    expect(byText.get("other bot reply")?.entityId).toBe(OTHER_BOT_ID);
    expect(byText.get("hello")?.entityId).toBe(HUMAN_ID);
  });
});
