/**
 * The message connector `sendHandler` the service registers must forward the
 * receipt `handleSendMessage` returns. Without it every proactive
 * `sendMessageToTarget("telegram")` reports unknown acceptance.
 */
import {
  type IAgentRuntime,
  inspectSendHandlerResult,
  type SendHandlerOutcome,
} from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { TelegramService } from "./service";

it("forwards the delivery receipt from the registered send handler", async () => {
  let registration:
    | { sendHandler: (...args: unknown[]) => Promise<unknown> }
    | undefined;
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000a1",
    registerMessageConnector: (value: typeof registration) => {
      registration ??= value;
    },
    registerSendHandler: () => {},
    logger: { info() {}, warn() {}, debug() {}, error() {} },
  } as unknown as IAgentRuntime;
  const delivered: SendHandlerOutcome = {
    kind: "delivered",
    receipt: {
      provider: "telegram",
      providerMessageIds: ["777"],
      acceptedAt: Date.now(),
      persistence: { status: "persisted", memoryIds: ["memory-777"] },
    },
    memories: [],
  };
  const service = {
    bot: {},
    getAccountIds: () => [],
    getDefaultAccountState: () => ({ account: { name: "stub" } }),
    getAccountState: () => undefined,
    handleSendMessage: vi.fn(async () => delivered),
  } as unknown as TelegramService;

  TelegramService.registerSendHandlers(runtime, service);

  const result = await registration?.sendHandler(
    runtime,
    { source: "telegram", channelId: "123456789" },
    { text: "Reminder: pay the rent today." },
  );
  expect(service.handleSendMessage).toHaveBeenCalledTimes(1);
  expect(result).toBe(delivered);
  expect(inspectSendHandlerResult(result as never).kind).toBe("delivered");
});
