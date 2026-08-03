/**
 * Production-path coverage for Telegram safe activation: MessageManager handles
 * Telegraf message contexts with the typed connector policy already present on
 * `character.settings.telegram`, and only addressed/authorized updates reach
 * memory or model dispatch.
 */
import type {
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MessageManager } from "./messageManager";

const BOT_USER = {
  id: 9001,
  is_bot: true,
  first_name: "Agent",
  username: "agent_bot",
};

type RuntimeOptions = {
  telegram?: Record<string, unknown>;
  autoReply?: boolean;
  handleMessage?: (
    runtime: IAgentRuntime,
    memory: Memory,
    callback: HandlerCallback,
  ) => Promise<void>;
};

function createHarness(options: RuntimeOptions = {}) {
  const createMemory = vi.fn(async () => undefined);
  const ensureConnection = vi.fn(async () => undefined);
  const sendMessage = vi.fn(async (chatId: string | number, text: string) => ({
    message_id: 500,
    date: 1_700_000_010,
    text,
    chat: { id: chatId, type: "supergroup" },
  }));
  const sendChatAction = vi.fn(async () => undefined);
  const messageService = {
    handleMessage: vi.fn(
      options.handleMessage ??
        (async () => {
          return undefined;
        }),
    ),
  };
  const runtime = {
    agentId: "agent-1",
    character: {
      name: "Agent",
      settings: {
        telegram: options.telegram ?? {
          botToken: "token",
          dmPolicy: "allowlist",
          allowFrom: ["42"],
          groupPolicy: "allowlist",
          groupAllowFrom: ["42"],
          groups: {
            "-1001": { requireMention: true },
          },
        },
      },
    },
    createMemory,
    ensureConnection,
    messageService,
    getSetting: vi.fn((key: string) => {
      if (key === "TELEGRAM_AUTO_REPLY" && options.autoReply) {
        return "true";
      }
      return undefined;
    }),
    getService: vi.fn(() => null),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime & {
    createMemory: ReturnType<typeof vi.fn>;
    ensureConnection: ReturnType<typeof vi.fn>;
    messageService: { handleMessage: ReturnType<typeof vi.fn> };
  };
  const bot = {
    botInfo: BOT_USER,
    telegram: {
      sendMessage,
      sendChatAction,
    },
  };

  return {
    manager: new MessageManager(bot as never, runtime),
    runtime,
    sendMessage,
  };
}

function groupContext(overrides: Record<string, unknown> = {}) {
  return {
    from: {
      id: 42,
      first_name: "Ada",
      username: "ada",
      is_bot: false,
    },
    chat: { id: -1001, type: "supergroup", title: "Ops" },
    message: {
      message_id: 10,
      date: 1_700_000_000,
      text: "hello room",
      chat: { id: -1001, type: "supergroup", title: "Ops" },
      ...overrides,
    },
  };
}

describe("MessageManager typed Telegram activation policy", () => {
  it("does not create memory or dispatch for unaddressed ordinary group traffic", async () => {
    const { manager, runtime } = createHarness();

    await manager.handleMessage(groupContext() as never);

    expect(runtime.ensureConnection).not.toHaveBeenCalled();
    expect(runtime.createMemory).not.toHaveBeenCalled();
    expect(runtime.messageService.handleMessage).not.toHaveBeenCalled();
  });

  it("blocks unauthorized senders and unconfigured groups before memory, even for forced commands", async () => {
    const { manager, runtime } = createHarness();
    const mention = {
      text: "@agent_bot run",
      entities: [{ type: "mention", offset: 0, length: 10 }],
    };

    await manager.handleMessage(
      {
        ...groupContext(mention),
        from: {
          id: 7,
          first_name: "Eve",
          username: "eve",
          is_bot: false,
        },
      } as never,
      { forceReply: true },
    );

    await manager.handleMessage({
      ...groupContext({
        ...mention,
        chat: { id: -9999, type: "supergroup", title: "Other" },
      }),
      chat: { id: -9999, type: "supergroup", title: "Other" },
    } as never);

    expect(runtime.ensureConnection).not.toHaveBeenCalled();
    expect(runtime.createMemory).not.toHaveBeenCalled();
    expect(runtime.messageService.handleMessage).not.toHaveBeenCalled();
  });

  it("dispatches native mentions and strips only the addressed bot mention", async () => {
    const { manager, runtime } = createHarness();

    await manager.handleMessage(
      groupContext({
        text: "@agent_bot hello @someone_else",
        entities: [{ type: "mention", offset: 0, length: 10 }],
      }) as never,
    );

    expect(runtime.messageService.handleMessage).toHaveBeenCalledTimes(1);
    const memory = runtime.messageService.handleMessage.mock.calls[0][1];
    expect(memory.content.text).toBe("hello @someone_else");
    expect(runtime.createMemory).not.toHaveBeenCalled();
  });

  it("dispatches replies to the bot without a mention", async () => {
    const { manager, runtime } = createHarness();

    await manager.handleMessage(
      groupContext({
        reply_to_message: {
          message_id: 9,
          date: 1_699_999_999,
          text: "agent reply",
          chat: { id: -1001, type: "supergroup", title: "Ops" },
          from: BOT_USER,
        },
      }) as never,
    );

    expect(runtime.messageService.handleMessage).toHaveBeenCalledTimes(1);
    const memory = runtime.messageService.handleMessage.mock.calls[0][1];
    expect(memory.content.inReplyTo).toBeDefined();
  });

  it("obeys typed DM allowlist policy", async () => {
    const { manager, runtime } = createHarness();

    await manager.handleMessage({
      from: { id: 42, first_name: "Ada", username: "ada", is_bot: false },
      chat: { id: 42, type: "private", first_name: "Ada" },
      message: {
        message_id: 11,
        date: 1_700_000_000,
        text: "hello",
        chat: { id: 42, type: "private", first_name: "Ada" },
      },
    } as never);

    expect(runtime.messageService.handleMessage).toHaveBeenCalledTimes(1);

    await manager.handleMessage({
      from: { id: 7, first_name: "Eve", username: "eve", is_bot: false },
      chat: { id: 7, type: "private", first_name: "Eve" },
      message: {
        message_id: 12,
        date: 1_700_000_000,
        text: "hello",
        chat: { id: 7, type: "private", first_name: "Eve" },
      },
    } as never);

    expect(runtime.messageService.handleMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps topic identity and delivers generated replies to the thread and source message", async () => {
    const { manager, runtime, sendMessage } = createHarness({
      telegram: {
        botToken: "token",
        groupPolicy: "allowlist",
        groupAllowFrom: ["42"],
        replyToMode: "first",
        groups: {
          "-1001": {
            requireMention: true,
            topics: { "77": { requireMention: true } },
          },
        },
      },
      handleMessage: async (_runtime, _memory, callback) => {
        await callback({ text: "thread reply" } as Content);
      },
    });

    await manager.handleMessage({
      ...groupContext({
        text: "@agent_bot thread",
        entities: [{ type: "mention", offset: 0, length: 10 }],
        is_topic_message: true,
        message_thread_id: 77,
      }),
      telegram: {
        sendMessage,
        sendChatAction: vi.fn(async () => undefined),
      },
    } as never);

    expect(sendMessage).toHaveBeenCalledWith(
      -1001,
      "thread reply",
      expect.objectContaining({
        message_thread_id: 77,
        reply_parameters: { message_id: 10 },
      }),
    );
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
    const responseMemory = runtime.createMemory.mock.calls[0][0];
    expect(responseMemory.roomId).toBe(
      runtime.messageService.handleMessage.mock.calls[0][1].roomId,
    );
    expect(responseMemory.metadata.telegram).toMatchObject({
      chatId: -1001,
      threadId: "77",
    });
  });

  it("does not let legacy auto-reply override typed group mention policy", async () => {
    const { manager, runtime } = createHarness({ autoReply: true });

    await manager.handleMessage(groupContext() as never);

    expect(runtime.createMemory).not.toHaveBeenCalled();
    expect(runtime.messageService.handleMessage).not.toHaveBeenCalled();
  });
});
