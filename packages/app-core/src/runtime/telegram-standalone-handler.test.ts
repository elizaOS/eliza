import {
  type AgentRuntime,
  type HandlerCallback,
  type Memory,
  stringToUuid,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleTelegramStandaloneMessage,
  type TelegramStandaloneContext,
} from "./telegram-standalone-handler";

function createRuntime() {
  const runtime = {
    agentId: stringToUuid("telegram-agent"),
    getSetting: vi.fn(() => undefined),
    ensureConnection: vi.fn(async () => undefined),
    createMemory: vi.fn(async () => undefined),
    messageService: {
      handleMessage: vi.fn(
        async (
          _runtime: AgentRuntime,
          _message: Memory,
          callback?: HandlerCallback,
          _options?: Record<string, unknown>,
        ) => {
          await callback?.({ text: "handled by runtime", actions: ["REPLY"] });
        },
      ),
    },
    useModel: vi.fn(),
  };
  return runtime as unknown as AgentRuntime & typeof runtime;
}

function createContext(): TelegramStandaloneContext {
  return {
    message: {
      message_id: 42,
      date: 1_714_000_000,
      text: "please use an action",
      chat: { id: 123, type: "private", first_name: "Sam" },
      from: {
        id: 99,
        username: "sam",
        first_name: "Sam",
        is_bot: false,
      },
    },
    chat: { id: 123, type: "private", first_name: "Sam" },
    from: {
      id: 99,
      username: "sam",
      first_name: "Sam",
      is_bot: false,
    },
    reply: vi.fn(async (text: string) => ({
      message_id: 43,
      date: 1_714_000_001,
      text,
      chat: { id: 123 },
    })),
  };
}

describe("handleTelegramStandaloneMessage", () => {
  beforeEach(() => {
    delete process.env.TELEGRAM_ALLOWED_CHATS;
  });

  it("dispatches Telegram messages through the runtime message service", async () => {
    const runtime = createRuntime();
    const ctx = createContext();

    await handleTelegramStandaloneMessage(runtime, ctx);

    expect(runtime.ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "telegram",
        channelId: "123",
        userName: "sam",
        name: "Sam",
      }),
    );
    expect(runtime.messageService.handleMessage).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        agentId: runtime.agentId,
        content: expect.objectContaining({
          text: "please use an action",
          source: "telegram",
        }),
      }),
      expect.any(Function),
      { continueAfterActions: true },
    );
    expect(ctx.reply).toHaveBeenCalledWith("handled by runtime");
    expect(runtime.createMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: runtime.agentId,
        content: expect.objectContaining({
          text: "handled by runtime",
          source: "telegram",
        }),
      }),
      "messages",
    );
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("drops messages outside the allowed chat list before runtime dispatch", async () => {
    const runtime = createRuntime();
    runtime.getSetting.mockReturnValue('["999"]');
    const ctx = createContext();

    await handleTelegramStandaloneMessage(runtime, ctx);

    expect(runtime.messageService.handleMessage).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(runtime.useModel).not.toHaveBeenCalled();
  });
});
