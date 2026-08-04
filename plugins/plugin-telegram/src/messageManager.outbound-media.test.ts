/**
 * Unit tests for outbound media dispatch: each `Media` attachment routes to the
 * matching Telegram sender (sendPhoto / sendVideo / sendAudio / sendDocument) by
 * coarse content type, unknown types produce a visible unsupported-media
 * notice, and accompanying prose is sent alongside. Telegraf send calls are
 * mocked.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MessageManager } from "./messageManager";

// Outbound media coverage for the Telegram connector (#8876): when the agent
// sends a message that carries `Media` attachments, each attachment must be
// dispatched through the matching Telegram API method (sendPhoto / sendVideo /
// sendAudio / sendDocument) by coarse content type, with the description as the
// caption. Exercised with a fully mocked Telegraf context so it runs offline
// (no live Telegram), mirroring messageManager.test.ts. Content types are plain
// string literals (not the ContentType enum) to stay robust to a stale core
// dist in the plugin's vitest sandbox.

function setup() {
  const runtime = {
    agentId: "agent-1",
    getSetting: () => undefined,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
  const manager = new MessageManager(
    { telegram: {} } as never,
    runtime as never,
  );

  const sent = (message_id: number, chatId = 123, caption?: string) => ({
    message_id,
    date: 1_700_000_000 + message_id,
    caption,
    chat: { id: chatId, type: "private" },
  });
  const senders = {
    sendPhoto: vi.fn(
      async (
        chatId: number | string,
        _url: string,
        opts?: { caption?: string },
      ) => sent(1, Number(chatId), opts?.caption),
    ),
    sendVideo: vi.fn(
      async (
        chatId: number | string,
        _url: string,
        opts?: { caption?: string },
      ) => sent(2, Number(chatId), opts?.caption),
    ),
    sendAudio: vi.fn(
      async (
        chatId: number | string,
        _url: string,
        opts?: { caption?: string },
      ) => sent(3, Number(chatId), opts?.caption),
    ),
    sendVoice: vi.fn(
      async (
        chatId: number | string,
        _url: string,
        opts?: { caption?: string },
      ) => sent(4, Number(chatId), opts?.caption),
    ),
    sendDocument: vi.fn(
      async (
        chatId: number | string,
        _url: string,
        opts?: { caption?: string },
      ) => sent(5, Number(chatId), opts?.caption),
    ),
    sendAnimation: vi.fn(
      async (
        chatId: number | string,
        _url: string,
        opts?: { caption?: string },
      ) => sent(6, Number(chatId), opts?.caption),
    ),
    sendChatAction: vi.fn(async () => undefined),
    sendMessage: vi.fn(async (chatId: number | string, text: string) => ({
      message_id: 9,
      date: 1_700_000_000,
      text,
      chat: { id: chatId, type: "private" },
    })),
  };
  const ctx = { chat: { id: 123 }, telegram: senders } as never;
  return { manager, ctx, senders };
}

describe("Telegram connector outbound media", () => {
  it("dispatches an image attachment via sendPhoto with the caption", async () => {
    const { manager, ctx, senders } = setup();
    await manager.sendMessageInChunks(ctx, {
      text: "",
      attachments: [
        {
          id: "img",
          url: "https://cdn.example.com/cat.png",
          contentType: "image",
          description: "a cat",
        },
      ],
    } as never);

    expect(senders.sendPhoto).toHaveBeenCalledTimes(1);
    expect(senders.sendPhoto).toHaveBeenCalledWith(
      123,
      "https://cdn.example.com/cat.png",
      expect.objectContaining({ caption: "a cat", parse_mode: "MarkdownV2" }),
    );
    // Attachment-only reply: no trailing empty text message.
    expect(senders.sendMessage).not.toHaveBeenCalled();
  });

  it("dispatches video and audio attachments via the matching senders", async () => {
    const { manager, ctx, senders } = setup();
    await manager.sendMessageInChunks(ctx, {
      text: "",
      attachments: [
        {
          id: "vid",
          url: "https://cdn.example.com/clip.mp4",
          contentType: "video",
        },
        {
          id: "aud",
          url: "https://cdn.example.com/clip.mp3",
          contentType: "audio",
        },
      ],
    } as never);

    expect(senders.sendVideo).toHaveBeenCalledWith(
      123,
      "https://cdn.example.com/clip.mp4",
      {
        caption: undefined,
        message_thread_id: undefined,
        parse_mode: undefined,
        reply_parameters: undefined,
      },
    );
    expect(senders.sendAudio).toHaveBeenCalledWith(
      123,
      "https://cdn.example.com/clip.mp3",
      {
        caption: undefined,
        message_thread_id: undefined,
        parse_mode: undefined,
        reply_parameters: undefined,
      },
    );
  });

  it("sends a document attachment, and visibly reports an unknown type", async () => {
    const { manager, ctx, senders } = setup();
    await manager.sendMessageInChunks(ctx, {
      text: "",
      attachments: [
        {
          id: "doc",
          url: "https://cdn.example.com/report.pdf",
          contentType: "document",
        },
        { id: "blob", url: "https://cdn.example.com/data.bin" },
      ],
    } as never);

    expect(senders.sendDocument).toHaveBeenCalledTimes(1);
    expect(senders.sendDocument).toHaveBeenCalledWith(
      123,
      "https://cdn.example.com/report.pdf",
      {
        caption: undefined,
        message_thread_id: undefined,
        parse_mode: undefined,
        reply_parameters: undefined,
      },
    );
    expect(senders.sendMessage).toHaveBeenCalledWith(
      123,
      expect.stringContaining("could not send"),
      expect.objectContaining({ parse_mode: "MarkdownV2" }),
    );
  });

  it("sends both the media and the accompanying prose when text is present", async () => {
    const { manager, ctx, senders } = setup();
    await manager.sendMessageInChunks(ctx, {
      text: "Here's the photo you asked for.",
      attachments: [
        {
          id: "img",
          url: "https://cdn.example.com/cat.png",
          contentType: "image",
        },
      ],
    } as never);

    expect(senders.sendPhoto).toHaveBeenCalledTimes(1);
    expect(senders.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("preserves thread/reply options, sends sequentially, and uses sendVoice for voice notes", async () => {
    const { manager, ctx, senders } = setup();
    const sent = await manager.sendMessageInChunks(
      ctx,
      {
        text: "[[audio_as_voice]]",
        attachments: [
          {
            id: "v1",
            url: "https://cdn.example.com/voice.ogg",
            contentType: "audio",
            source: "Voice Note",
            description: "voice caption",
          },
          {
            id: "p1",
            url: "https://cdn.example.com/p.png",
            contentType: "image",
          },
        ],
      } as never,
      88,
      9,
    );

    expect(senders.sendVoice.mock.invocationCallOrder[0]).toBeLessThan(
      senders.sendPhoto.mock.invocationCallOrder[0],
    );
    expect(senders.sendVoice).toHaveBeenCalledWith(
      123,
      "https://cdn.example.com/voice.ogg",
      expect.objectContaining({
        caption: "voice caption",
        message_thread_id: 9,
        reply_parameters: { message_id: 88 },
      }),
    );
    expect(senders.sendPhoto).toHaveBeenCalledWith(
      123,
      "https://cdn.example.com/p.png",
      expect.objectContaining({
        message_thread_id: 9,
        reply_parameters: undefined,
      }),
    );
    expect(senders.sendMessage).not.toHaveBeenCalled();
    expect(sent.map((message) => message.message_id)).toEqual([4, 1]);
  });
});
