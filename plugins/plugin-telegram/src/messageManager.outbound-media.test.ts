/**
 * Unit tests for outbound media dispatch: each `Media` attachment routes to the
 * matching Telegram sender by coarse content type, bytes are resolved through
 * the guarded fetch / media store (never as a local path), accompanying prose
 * is sent even when an attachment fails, and logs never include a data-URL
 * payload. Telegraf send calls are mocked.
 */
import fs from "node:fs";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaType, MessageManager } from "./messageManager";

// Outbound media coverage for the Telegram connector (#8876 / #32027): when the
// agent sends a message that carries `Media` attachments, each attachment must
// be dispatched through the matching Telegram API method by coarse content type,
// with the description as the caption. Bytes come from the shared outbound
// resolver. Exercised with a fully mocked Telegraf context so it runs offline.

const PNG_DATA_URL = "data:image/png;base64,aGVsbG8=";
const VIDEO_DATA_URL = "data:video/mp4;base64,Y2xpcA==";
const AUDIO_DATA_URL = "data:audio/mpeg;base64,Y2xpcA==";
const PDF_DATA_URL = "data:application/pdf;base64,cmVwb3J0";
const BIN_DATA_URL = "data:application/octet-stream;base64,ZGF0YQ==";

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Telegram connector outbound media", () => {
  it("dispatches an image attachment via sendPhoto with the caption", async () => {
    const { manager, ctx, senders } = setup();
    await manager.sendMessageInChunks(ctx, {
      text: "",
      attachments: [
        {
          id: "img",
          url: PNG_DATA_URL,
          contentType: "image",
          description: "a cat",
        },
      ],
    } as never);

    expect(senders.sendPhoto).toHaveBeenCalledTimes(1);
    expect(senders.sendPhoto).toHaveBeenCalledWith(
      123,
      expect.objectContaining({ source: expect.any(Buffer) }),
      { caption: "a cat" },
    );
    expect(
      Buffer.from(
        (senders.sendPhoto.mock.calls[0][1] as { source: Buffer }).source,
      ).toString("utf8"),
    ).toBe("hello");
    expect(senders.sendMessage).not.toHaveBeenCalled();
  });

  it("dispatches video and audio attachments via the matching senders", async () => {
    const { manager, ctx, senders } = setup();
    await manager.sendMessageInChunks(ctx, {
      text: "",
      attachments: [
        {
          id: "vid",
          url: VIDEO_DATA_URL,
          contentType: "video",
        },
        {
          id: "aud",
          url: AUDIO_DATA_URL,
          contentType: "audio",
        },
      ],
    } as never);

    expect(senders.sendVideo).toHaveBeenCalledWith(
      123,
      expect.objectContaining({ source: expect.any(Buffer) }),
      { caption: undefined },
    );
    expect(senders.sendAudio).toHaveBeenCalledWith(
      123,
      expect.objectContaining({ source: expect.any(Buffer) }),
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
          url: PDF_DATA_URL,
          contentType: "document",
        },
        { id: "blob", url: BIN_DATA_URL },
      ],
    } as never);

    expect(senders.sendDocument).toHaveBeenCalledTimes(2);
  });

  it("sends both the media and the accompanying prose when text is present", async () => {
    const { manager, ctx, senders } = setup();
    await manager.sendMessageInChunks(ctx, {
      text: "Here's the photo you asked for.",
      attachments: [
        {
          id: "img",
          url: PNG_DATA_URL,
          contentType: "image",
        },
      ],
    } as never);

    expect(senders.sendPhoto).toHaveBeenCalledTimes(1);
    expect(senders.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("routes resolved media through the active forum topic", async () => {
    const { manager, ctx, senders } = setup();

    await manager.sendMessageInChunks(
      ctx,
      {
        text: "",
        attachments: [
          {
            id: "img",
            url: PNG_DATA_URL,
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
      expect.objectContaining({ source: expect.any(Buffer) }),
      { caption: "a cat", message_thread_id: 77 },
    );
  });

  it("routes data-URL media through the active forum topic", async () => {
    const { manager, ctx, senders } = setup();

    await manager.sendMedia(
      ctx,
      PNG_DATA_URL,
      MediaType.DOCUMENT,
      "report",
      88,
    );

    expect(senders.sendDocument).toHaveBeenCalledWith(
      123,
      expect.objectContaining({ source: expect.any(Buffer) }),
      { caption: "report", message_thread_id: 88 },
    );
  });

  it("delivers an over-limit media caption completely as follow-up text", async () => {
    const { manager, ctx, senders } = setup();
    const caption = `${"a".repeat(4095)}🦊\n\n${"z".repeat(1025)}`;

    await manager.sendMedia(ctx, PNG_DATA_URL, MediaType.PHOTO, caption, 88);

    expect(senders.sendPhoto).toHaveBeenCalledWith(
      123,
      expect.objectContaining({ source: expect.any(Buffer) }),
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

  it("rejects a local secrets path without reading it", async () => {
    const { manager, ctx, senders } = setup();
    const readSpy = vi.spyOn(fs, "readFileSync");
    const existsSpy = vi.spyOn(fs, "existsSync");
    const streamSpy = vi.spyOn(fs, "createReadStream");

    await expect(
      manager.sendMedia(ctx, "/etc/passwd", MediaType.DOCUMENT),
    ).rejects.toThrow();
    expect(senders.sendDocument).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(existsSpy).not.toHaveBeenCalled();
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it("sends text even when an attachment fails and does not log the data-URL payload", async () => {
    const { manager, ctx, senders } = setup();
    const warnSpy = vi.spyOn((await import("@elizaos/core")).logger, "warn");
    const errorSpy = vi.spyOn((await import("@elizaos/core")).logger, "error");

    await manager.sendMessageInChunks(ctx, {
      text: "caption still goes out",
      attachments: [
        {
          id: "bad",
          url: "/etc/passwd",
          contentType: "document",
        },
      ],
    } as never);

    expect(senders.sendDocument).not.toHaveBeenCalled();
    expect(senders.sendMessage).toHaveBeenCalled();
    expect(String(senders.sendMessage.mock.calls[0][1])).toContain(
      "caption still goes out",
    );
    const logs = JSON.stringify([
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
    ]);
    expect(logs).not.toContain("/etc/passwd");
    expect(logs).not.toContain("aGVsbG8=");
  });

  it("fetches http(s) bytes through the SSRF guard and uploads the buffer", async () => {
    const { manager, ctx, senders } = setup();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Buffer.from("png-bytes"), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    await manager.sendMedia(
      ctx,
      "https://cdn.example.com/cat.png",
      MediaType.PHOTO,
      "a cat",
      undefined,
      {
        lookupFn: async () => [{ address: "203.0.113.7", family: 4 }],
        pinnedFetchImpl: async ({ url, init }) =>
          fetchMock(url.toString(), init),
        fetchImpl: async (input, init) => fetchMock(String(input), init),
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(senders.sendPhoto).toHaveBeenCalledWith(
      123,
      expect.objectContaining({ source: expect.any(Buffer) }),
      { caption: "a cat" },
    );
    expect(
      Buffer.from(
        (senders.sendPhoto.mock.calls[0][1] as { source: Buffer }).source,
      ).toString("utf8"),
    ).toBe("png-bytes");
  });

  it("fails closed when the guarded http fetch is not ok", async () => {
    const { manager, ctx, senders } = setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("bad", { status: 502 }));

    await expect(
      manager.sendMedia(
        ctx,
        "https://cdn.example.com/cat.png",
        MediaType.PHOTO,
        undefined,
        undefined,
        {
          lookupFn: async () => [{ address: "203.0.113.7", family: 4 }],
          pinnedFetchImpl: async ({ url, init }) =>
            fetchMock(url.toString(), init),
          fetchImpl: async (input, init) => fetchMock(String(input), init),
        },
      ),
    ).rejects.toThrow(/HTTP 502/);
    expect(senders.sendPhoto).not.toHaveBeenCalled();
  });
});
