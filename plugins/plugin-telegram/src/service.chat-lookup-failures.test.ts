/**
 * `getTelegramChatForTarget` is the only place connector chat lookups reach the
 * Bot API. Returning `null` for every failure made an auth failure, a rate
 * limit or a Telegram outage indistinguishable from "this chat does not
 * exist": `listConnectorTargets` then reports no match for a chat that really
 * exists and `getConnectorChatContext` labels the target by its raw id.
 *
 * Only `400 Bad Request` (chat not found / not a member) is legitimate
 * absence. Everything else must reach the caller.
 */
import type {
  IAgentRuntime,
  MessageConnectorChatContext,
  MessageConnectorQueryContext,
  TargetInfo,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { TelegramService } from "./service";

const GROUP = "-1001234567890";

function telegramError(errorCode: number, description: string): Error {
  return Object.assign(new Error(`${errorCode}: ${description}`), {
    response: { error_code: errorCode, description },
  });
}

function harness(getChat: (chatId: number | string) => Promise<unknown>) {
  const runtime = {
    agentId: "00000000-0000-4000-8000-0000000000b2",
  } as unknown as IAgentRuntime;
  Object.assign(runtime, {
    getMemories: async () => [],
    getAllMemories: async () => [],
    getRoom: async () => null,
    getSetting: () => undefined,
  });
  const service = Object.create(TelegramService.prototype) as TelegramService;
  Object.assign(service, {
    runtime,
    defaultAccountId: "default",
    accountStates: new Map(),
    knownChats: new Map(),
    bot: { telegram: { getChat } },
  });
  const context = { runtime } as unknown as MessageConnectorQueryContext;
  const target = {
    source: "telegram",
    accountId: "default",
    channelId: GROUP,
  } as unknown as TargetInfo;
  const lookUp = () =>
    service.getConnectorChatContext(
      target,
      context,
    ) as Promise<MessageConnectorChatContext | null>;
  return { lookUp };
}

it.each([401, 403, 429, 500])(
  "propagates a Telegram %i from the chat lookup instead of reporting the chat as absent",
  async (errorCode) => {
    const failure = telegramError(errorCode, "Unauthorized");
    const { lookUp } = harness(async () => {
      throw failure;
    });
    await expect(lookUp()).rejects.toBe(failure);
  },
);

it("keeps a 400 chat-not-found as an absent chat", async () => {
  const { lookUp } = harness(async () => {
    throw telegramError(400, "Bad Request: chat not found");
  });
  const resolved = await lookUp();
  // No Chat object was returned, so the context falls back to the raw id.
  expect(resolved?.label).toBe(GROUP);
  expect(resolved?.summary).toBeUndefined();
});
