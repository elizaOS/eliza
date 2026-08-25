/**
 * Unit tests for outbound media dispatch: each `Media` attachment routes to the
 * matching Telegram sender (sendPhoto / sendVideo / sendAudio / sendDocument) by
 * coarse content type, unknown types degrade to a document, and accompanying
 * prose is sent alongside. Telegraf send calls are mocked.
 */
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MediaType, MessageManager } from "./messageManager";

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

  const senders = {
    sendPhoto: vi.fn(async () => ({ message_id: 1 })),
    sendVideo: vi.fn(async () => ({ message_id: 2 })),
    sendAudio: vi.fn(async () => ({ message_id: 3 })),
    sendDocument: vi.fn(async () => ({ message_id: 4 })),
    sendAnimation: vi.fn(async () => ({ message_id: 5 })),
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
      { caption: "a cat" },
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
      { caption: undefined },
    );
    expect(senders.sendAudio).toHaveBeenCalledWith(
      123,
      "https://cdn.example.com/clip.mp3",
      { caption: undefined },
    );
  });

  it("sends a document attachment, and degrades an unknown type to a document", async () => {
    const { manager, ctx, senders } = setup();
    await manager.sendMessageInChunks(ctx, {
      text: "",
      attachments: [
        {
          id: "doc",
          url: "https://cdn.example.com/report.pdf",
          contentType: "document",
        },
        // No contentType → degrades to a document upload (never throws/drops).
        { id: "blob", url: "https://cdn.example.com/data.bin" },
      ],
    } as never);

    expect(senders.sendDocument).toHaveBeenCalledTimes(2);
    expect(senders.sendDocument).toHaveBeenCalledWith(
      123,
      "https://cdn.example.com/report.pdf",
      { caption: undefined },
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

  it("routes URL media through the active forum topic", async () => {
    const { manager, ctx, senders } = setup();

    await manager.sendMessageInChunks(
      ctx,
      {
        text: "",
        attachments: [
          {
            id: "img",
            url: "https://cdn.example.com/cat.png",
            contentType: "image",
            description: "a cat",
          },
        ],
      } as never,
      undefined,
      77,
    );

    expect(senders.sendPhoto).toHaveBeenCalledWith(
      123,
      "https://cdn.example.com/cat.png",
      { caption: "a cat", message_thread_id: 77 },
    );
  });

  it("routes local-file media through the active forum topic", async () => {
    const { manager, ctx, senders } = setup();
    const filePath = fileURLToPath(
      new URL("./messageManager.ts", import.meta.url),
    );

    await manager.sendMedia(ctx, filePath, MediaType.DOCUMENT, "report", 88);

    expect(senders.sendDocument).toHaveBeenCalledWith(
      123,
      { source: expect.anything() },
      { caption: "report", message_thread_id: 88 },
    );
  });

  it("delivers an over-limit media caption completely as follow-up text", async () => {
    const { manager, ctx, senders } = setup();
    const caption = `${"a".repeat(4095)}🦊\n\n${"z".repeat(1025)}`;

    await manager.sendMedia(
      ctx,
      "https://cdn.example.com/cat.png",
      MediaType.PHOTO,
      caption,
      88,
    );

    expect(senders.sendPhoto).toHaveBeenCalledWith(
      123,
      "https://cdn.example.com/cat.png",
      { caption: undefined, message_thread_id: 88 },
    );
    const followUps = senders.sendMessage.mock.calls.map((call) => call[1]);
    expect(followUps).toHaveLength(2);
    expect(followUps.join("")).toBe(caption);
    expect(followUps.every((chunk) => chunk.length <= 4096)).toBe(true);
    expect(followUps.every((chunk) => chunk.isWellFormed())).toBe(true);
    expect(senders.sendMessage.mock.calls.map((call) => call[2])).toEqual([
      { message_thread_id: 88 },
      { message_thread_id: 88 },
    ]);
  });
});
