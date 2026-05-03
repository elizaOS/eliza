import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MessageManager } from "../src/messageManager";

describe("MessageManager metadata", () => {
  it("records Telegram sender identity on inbound message metadata", async () => {
    let capturedMemory: Memory | null = null;
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getSetting: vi.fn(() => undefined),
      ensureConnection: vi.fn().mockResolvedValue(undefined),
      createMemory: vi.fn(async (memory: Memory) => {
        capturedMemory = memory;
      }),
      messageService: {
        handleMessage: vi.fn(),
      },
    } as unknown as IAgentRuntime & {
      messageService: { handleMessage: ReturnType<typeof vi.fn> };
    };
    const manager = new MessageManager({} as never, runtime);
    const chat = { id: -100123, type: "supergroup", title: "Test Chat" };

    await manager.handleMessage({
      from: {
        id: 42,
        is_bot: false,
        first_name: "Alice",
        username: "alice_handle",
      },
      chat,
      message: {
        message_id: 77,
        date: 1_700_000_000,
        text: "hello",
        chat,
      },
    } as never);

    expect(runtime.ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "42",
        userName: "alice_handle",
        name: "Alice",
        source: "telegram",
      }),
    );
    expect(runtime.messageService.handleMessage).not.toHaveBeenCalled();
    expect(capturedMemory?.metadata).toMatchObject({
      type: "message",
      source: "telegram",
      provider: "telegram",
      entityName: "Alice",
      entityUserName: "alice_handle",
      fromId: "42",
      sender: {
        id: "42",
        name: "Alice",
        username: "alice_handle",
      },
      telegramUserId: "42",
      telegramChatId: "-100123",
      telegram: {
        chatId: "-100123",
        messageId: "77",
      },
    });
    expect(capturedMemory?.metadata?.telegram).not.toHaveProperty("id");
    expect(capturedMemory?.metadata?.telegram).not.toHaveProperty("userId");
    expect(capturedMemory?.metadata?.telegram).not.toHaveProperty("name");
    expect(capturedMemory?.metadata?.telegram).not.toHaveProperty("username");
  });
});
