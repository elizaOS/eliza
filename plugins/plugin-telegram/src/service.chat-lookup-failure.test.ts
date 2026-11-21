/**
 * Connector target lookup: `getChat` failing for an operational reason (revoked
 * token, rate limit, network) must not be reported to the caller as "this chat
 * does not exist". A chat that genuinely cannot be seen (400 chat not found,
 * 403 bot not a member) still resolves to no target, because that is what the
 * Bot API says about every id the bot cannot reach.
 */
import type {
  IAgentRuntime,
  MessageConnectorQueryContext,
} from "@elizaos/core";
import { ElizaError } from "@elizaos/core";
import { expect, it } from "vitest";
import { TelegramService } from "./service";

function harness(getChat: (chatId: string) => Promise<unknown>) {
  const runtime = {
    agentId: "00000000-0000-4000-8000-0000000000a1",
    getRoom: async () => null,
  } as unknown as IAgentRuntime;
  const service = Object.create(TelegramService.prototype) as TelegramService;
  Object.assign(service, {
    runtime,
    defaultAccountId: "default",
    knownChats: new Map(),
    accountStates: new Map([
      ["default", { accountId: "default", bot: { telegram: { getChat } } }],
    ]),
  });
  const context = { runtime } as unknown as MessageConnectorQueryContext;
  return { service, context };
}

function botApiError(errorCode: number, description: string): Error {
  return Object.assign(new Error(description), {
    response: { error_code: errorCode, description },
  });
}

it("propagates a rate-limited chat lookup instead of no matching target", async () => {
  const { service, context } = harness(async () => {
    throw botApiError(429, "Too Many Requests: retry after 30");
  });

  const lookup = service.resolveConnectorTargets("@team", context);
  await expect(lookup).rejects.toBeInstanceOf(ElizaError);
  await expect(lookup).rejects.toMatchObject({
    code: "TELEGRAM_CHAT_LOOKUP_FAILED",
  });
});

it("propagates a rejected bot token instead of no matching target", async () => {
  const { service, context } = harness(async () => {
    throw botApiError(401, "Unauthorized");
  });

  await expect(
    service.resolveConnectorTargets("@team", context),
  ).rejects.toMatchObject({ code: "TELEGRAM_CHAT_LOOKUP_FAILED" });
});

it("still resolves a chat the bot cannot see to no target", async () => {
  const { service, context } = harness(async () => {
    throw botApiError(400, "Bad Request: chat not found");
  });

  await expect(
    service.resolveConnectorTargets("@ghost", context),
  ).resolves.toEqual([]);
});

it("propagates a transport failure that carries no Bot API status", async () => {
  const { service, context } = harness(async () => {
    throw new Error("socket hang up");
  });

  await expect(
    service.resolveConnectorTargets("@team", context),
  ).rejects.toMatchObject({ code: "TELEGRAM_CHAT_LOOKUP_FAILED" });
});
