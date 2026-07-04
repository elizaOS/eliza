/**
 * Unit tests for `MessageManager` edit/react paths: in-place MarkdownV2 edits
 * with plain-text fallback on a 400 parse error, the compact-progress callback
 * that edits one status message, and computer-use approval callback parsing.
 * Telegraf send/edit calls are mocked.
 */
import { type Content, encodeReplyCallback, type Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTelegramCompactProgressCallback,
  MessageManager,
  parseComputerUseApprovalCallback,
} from "./messageManager";

/**
 * Unit tests for the Telegram connector `edit_message` / `react_message`
 * capabilities (#8903). With edit available the orchestrator's compact progress
 * mode rewrites a single message across heartbeats instead of flooding the chat.
 */
function makeManager(runtimeOverrides: Record<string, unknown> = {}) {
  const editMessageText = vi.fn(async () => ({ message_id: 7 }));
  const sendChatAction = vi.fn(async () => true);
  const sendMessage = vi.fn(async (chatId: number | string, text: string) => ({
    message_id: 88,
    chat: { id: chatId },
    text,
    date: 1_700_000_001,
  }));
  const setMessageReaction = vi.fn(async () => true);
  const bot = {
    telegram: {
      editMessageText,
      sendChatAction,
      sendMessage,
      setMessageReaction,
    },
  };
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    createMemory: vi.fn(async () => undefined),
    ensureConnection: vi.fn(async () => undefined),
    getSetting: vi.fn(() => undefined),
    getService: vi.fn(() => null),
    ...runtimeOverrides,
  };
  const manager = new MessageManager(bot as never, runtime as never);
  return {
    manager,
    editMessageText,
    runtime,
    sendChatAction,
    sendMessage,
    setMessageReaction,
  };
}

describe("MessageManager.editMessage (#8903)", () => {
  let env: ReturnType<typeof makeManager>;
  beforeEach(() => {
    env = makeManager();
  });

  it("edits in place as MarkdownV2", async () => {
    await env.manager.editMessage(123, 7, "**bold** progress");
    expect(env.editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, messageId, inlineId, text, opts] =
      env.editMessageText.mock.calls[0];
    expect(chatId).toBe(123);
    expect(messageId).toBe(7);
    expect(inlineId).toBeUndefined();
    expect(typeof text).toBe("string");
    expect(opts).toEqual({ parse_mode: "MarkdownV2" });
  });

  it("falls back to plain text when MarkdownV2 is rejected (400 parse error)", async () => {
    const err = {
      response: {
        error_code: 400,
        description: "Bad Request: can't parse entities",
      },
    };
    env.editMessageText
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ message_id: 7 } as never);

    await env.manager.editMessage(123, 7, "**bold** progress");

    expect(env.editMessageText).toHaveBeenCalledTimes(2);
    // The retry carries no parse_mode (plain text).
    const retryOpts = env.editMessageText.mock.calls[1][4];
    expect(retryOpts).toBeUndefined();
  });
});

describe("createTelegramCompactProgressCallback (#8912)", () => {
  it("edits one status message for compact progress updates", async () => {
    const firstMemory = {
      metadata: { telegram: { messageId: "7" } },
    } as Memory;
    const baseCallback = vi.fn(async () => [firstMemory]);
    const editMessage = vi.fn(async () => undefined);
    const callback = createTelegramCompactProgressCallback({
      baseCallback,
      editMessage,
      chatId: 123,
      threadId: 456,
    });
    const progress = (text: string): Content => ({
      text,
      source: "action_progress",
      metadata: { compactProgress: true },
    });

    await callback(progress("Step 1: open — checking example"), "BROWSER");
    await callback(progress("Step 2: click — submit"), "BROWSER");
    await callback({ text: "ordinary reply", source: "telegram" }, "BROWSER");

    expect(baseCallback).toHaveBeenCalledTimes(2);
    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenCalledWith(
      123,
      7,
      "Step 2: click — submit",
      456,
    );
  });
});

describe("Telegram computer-use approval callbacks (#8912)", () => {
  it("parses compact approve/deny callback values", () => {
    expect(
      parseComputerUseApprovalCallback("cua:approval_123:approve"),
    ).toEqual({
      approvalId: "approval_123",
      approved: true,
    });
    expect(
      parseComputerUseApprovalCallback("cua:approval_123:approve:u42"),
    ).toEqual({
      approvalId: "approval_123",
      approved: true,
      ownerId: "42",
    });
    expect(parseComputerUseApprovalCallback("cua:approval_123:deny")).toEqual({
      approvalId: "approval_123",
      approved: false,
    });
    expect(parseComputerUseApprovalCallback("yes")).toBeNull();
  });

  it("resolves approvals from inline buttons and edits the prompt", async () => {
    const resolveApproval = vi.fn(() => ({
      id: "approval_123",
      command: "desktop_click",
    }));
    const getService = vi.fn((name: string) =>
      name === "computeruse" ? { resolveApproval } : null,
    );
    const env = makeManager({ getService });
    const data = encodeReplyCallback("cua:approval_123:approve:u42");
    expect(data).not.toBeNull();
    const answerCbQuery = vi.fn(async () => undefined);

    await env.manager.handleCallbackQuery({
      callbackQuery: {
        id: "cbq-1",
        data,
        message: {
          message_id: 77,
          chat: { id: 123, type: "private" },
          date: 1_700_000_000,
        },
      },
      from: {
        id: 42,
        first_name: "Ada",
        username: "ada",
        is_bot: false,
      },
      chat: { id: 123, type: "private" },
      telegram: { sendMessage: env.sendMessage },
      answerCbQuery,
    } as never);

    expect(answerCbQuery).toHaveBeenCalledWith("Approval accepted.");
    expect(resolveApproval).toHaveBeenCalledWith(
      "approval_123",
      true,
      "Resolved from Telegram inline button",
    );
    expect(env.runtime.createMemory).toHaveBeenCalledTimes(1);
    expect(env.editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, messageId, inlineId, text] =
      env.editMessageText.mock.calls[0];
    expect(chatId).toBe(123);
    expect(messageId).toBe(77);
    expect(inlineId).toBeUndefined();
    expect(text).toContain("Computer\\-use approval approved");
    expect(text).toContain("approval\\_123");
  });

  it("rejects approval clicks from a different Telegram user", async () => {
    const resolveApproval = vi.fn(() => ({
      id: "approval_123",
      command: "desktop_click",
    }));
    const getService = vi.fn((name: string) =>
      name === "computeruse" ? { resolveApproval } : null,
    );
    const env = makeManager({ getService });
    const data = encodeReplyCallback("cua:approval_123:approve:u42");
    expect(data).not.toBeNull();
    const answerCbQuery = vi.fn(async () => undefined);

    await env.manager.handleCallbackQuery({
      callbackQuery: {
        id: "cbq-2",
        data,
        message: {
          message_id: 77,
          chat: { id: -123, type: "group" },
          date: 1_700_000_000,
        },
      },
      from: {
        id: 99,
        first_name: "Grace",
        username: "grace",
        is_bot: false,
      },
      chat: { id: -123, type: "group" },
      answerCbQuery,
    } as never);

    expect(resolveApproval).not.toHaveBeenCalled();
    expect(env.runtime.createMemory).not.toHaveBeenCalled();
    expect(env.editMessageText).not.toHaveBeenCalled();
    expect(answerCbQuery).toHaveBeenCalledWith(
      "Only the requester can resolve this approval.",
      { show_alert: true },
    );
  });

  it("edits compact progress for callback-query turns after the first send", async () => {
    const data = encodeReplyCallback("continue");
    expect(data).not.toBeNull();
    const answerCbQuery = vi.fn(async () => undefined);
    const progress = (text: string): Content => ({
      text,
      source: "action_progress",
      metadata: { compactProgress: true },
    });
    const messageService = {
      handleMessage: vi.fn(
        async (
          _runtime: unknown,
          _memory: unknown,
          callback: (
            content: Content,
            actionName?: string,
          ) => Promise<Memory[]>,
        ) => {
          await callback(
            progress("Step 1: open — checking example"),
            "BROWSER",
          );
          await callback(progress("Step 2: click — submit"), "BROWSER");
        },
      ),
    };
    const env = makeManager({ messageService });

    await env.manager.handleCallbackQuery({
      callbackQuery: {
        id: "cbq-3",
        data,
        message: {
          message_id: 77,
          chat: { id: 123, type: "private" },
          date: 1_700_000_000,
        },
      },
      from: {
        id: 42,
        first_name: "Ada",
        username: "ada",
        is_bot: false,
      },
      chat: { id: 123, type: "private" },
      telegram: { sendMessage: env.sendMessage },
      answerCbQuery,
    } as never);

    expect(env.sendMessage).toHaveBeenCalledTimes(1);
    expect(env.editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, messageId, inlineId, text] =
      env.editMessageText.mock.calls[0];
    expect(chatId).toBe(123);
    expect(messageId).toBe(88);
    expect(inlineId).toBeUndefined();
    expect(text).toContain("Step 2: click");
  });
});

describe("MessageManager.addReaction (#8903)", () => {
  let env: ReturnType<typeof makeManager>;
  beforeEach(() => {
    env = makeManager();
  });

  it("sets a single emoji reaction", async () => {
    await env.manager.addReaction(123, 7, "👍");
    expect(env.setMessageReaction).toHaveBeenCalledWith(123, 7, [
      { type: "emoji", emoji: "👍" },
    ]);
  });

  it("clears reactions when no emoji is given", async () => {
    await env.manager.addReaction(123, 7, undefined);
    expect(env.setMessageReaction).toHaveBeenCalledWith(123, 7, []);
  });
});
