import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { TelegramService } from "./service";

function createRuntime() {
  return {
    agentId: "agent-1",
    registerMessageConnector: vi.fn(),
    registerSendHandler: vi.fn(),
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRoom: vi.fn().mockResolvedValue(null),
    getMemories: vi.fn().mockResolvedValue([]),
    getEntityById: vi.fn().mockResolvedValue(null),
  } as unknown as IAgentRuntime & {
    registerMessageConnector: ReturnType<typeof vi.fn>;
    registerSendHandler: ReturnType<typeof vi.fn>;
  };
}

describe("Telegram message connector adapter", () => {
  it("registers connector metadata with chat and thread support", () => {
    const runtime = createRuntime();
    const service = Object.create(TelegramService.prototype) as any;
    service.bot = {};
    service.messageManager = {};
    service.handleSendMessage = vi.fn();
    service.resolveConnectorTargets = vi.fn();
    service.listRecentConnectorTargets = vi.fn();
    service.listConnectorRooms = vi.fn();
    service.getConnectorChatContext = vi.fn();
    service.getConnectorUserContext = vi.fn();

    TelegramService.registerSendHandlers(runtime, service);

    expect(runtime.registerMessageConnector.mock.calls[0][0]).toMatchObject({
      source: "telegram",
      label: "Telegram",
      capabilities: expect.arrayContaining([
        "send_message",
        "resolve_targets",
        "chat_context",
        "user_context",
      ]),
      supportedTargetKinds: ["channel", "group", "thread", "user"],
      contexts: ["social", "connectors"],
    });
  });

  it("parses forum-topic channel IDs for unified sends", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue([]);
    const service = Object.create(TelegramService.prototype) as any;
    service.bot = {};
    service.messageManager = { sendMessage };

    await service.handleSendMessage(
      runtime,
      { source: "telegram", channelId: "-1001234567890-42" },
      { text: "hello" },
    );

    expect(sendMessage).toHaveBeenCalledWith(
      "-1001234567890",
      { text: "hello" },
      undefined,
      42,
    );
  });

  it("resolves known chats into connector targets", async () => {
    const runtime = createRuntime();
    const service = Object.create(TelegramService.prototype) as any;
    service.runtime = runtime;
    service.bot = null;
    service.knownChats = new Map([
      [
        "-100123",
        {
          id: -100123,
          type: "supergroup",
          title: "Ops Room",
          is_forum: true,
        },
      ],
    ]);

    const targets = await service.resolveConnectorTargets("ops", { runtime });

    expect(targets[0]).toMatchObject({
      label: "Ops Room",
      kind: "group",
      target: { source: "telegram", channelId: "-100123" },
    });
  });
});
