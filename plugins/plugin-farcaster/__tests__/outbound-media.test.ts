/**
 * Verifies that agent-generated `Media` attachments ride outbound casts as
 * url-based Farcaster embeds through both send paths (POST connector +
 * mention-reply callback), with a mocked Neynar client (no network).
 */
import type { Content, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { FarcasterCastService } from "../services/CastService";
import { extractCastEmbedUrls } from "../utils";
import { standardCastHandlerCallback } from "../utils/callbacks";

// Outbound media coverage for the Farcaster connector (#8876): agent-generated
// `Media` attachments must ride along as Farcaster cast EMBEDS (url-based) via
// handleSendPost → createCast → the send path. Mocked Neynar client → runs offline.

const agentId = "00000000-0000-0000-0000-000000000001" as const;

function runtime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    agentId,
    character: { settings: {} },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: vi.fn((key: string) => settings[key] ?? null),
    createMemory: vi.fn(),
    useModel: vi.fn(),
  } as unknown as IAgentRuntime;
}

function neynarCast(text: string) {
  return {
    hash: "0xabc123",
    thread_hash: "0xabc123",
    text,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    author: { fid: 1, display_name: "Eliza", username: "eliza" },
  };
}

function client() {
  return {
    getTimeline: vi.fn(async () => ({ timeline: [] })),
    sendCast: vi.fn(async ({ content }: { content: Content }) => [
      neynarCast(typeof content.text === "string" ? content.text : ""),
    ]),
  };
}

const ACCOUNT = "brand";

describe("Farcaster outbound media (embeds)", () => {
  it("sends agent attachments as cast embeds", async () => {
    const testClient = client();
    const rt = runtime({ FARCASTER_FID: "1" });
    const service = new FarcasterCastService(testClient as never, rt, ACCOUNT);

    await service.handleSendPost(rt, {
      text: "here's the image",
      accountId: ACCOUNT,
      attachments: [
        { id: "img", url: "https://cdn.example.com/cat.png", contentType: "image" },
        { id: "vid", url: "https://cdn.example.com/clip.mp4", contentType: "video" },
      ],
    } as Content);

    expect(testClient.sendCast).toHaveBeenCalledTimes(1);
    expect(testClient.sendCast).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: ["https://cdn.example.com/cat.png", "https://cdn.example.com/clip.mp4"],
      })
    );
  });

  it("sends a text-only post without embeds (no regression)", async () => {
    const testClient = client();
    const rt = runtime({ FARCASTER_FID: "1" });
    const service = new FarcasterCastService(testClient as never, rt, ACCOUNT);

    await service.handleSendPost(rt, {
      text: "just text",
      accountId: ACCOUNT,
    } as Content);

    expect(testClient.sendCast).toHaveBeenCalledTimes(1);
    const arg = testClient.sendCast.mock.calls[0][0] as { embeds?: string[] };
    expect(arg.embeds).toBeUndefined();
  });

  it("allows an attachment-only post (no text) instead of rejecting", async () => {
    const testClient = client();
    const rt = runtime({ FARCASTER_FID: "1" });
    const service = new FarcasterCastService(testClient as never, rt, ACCOUNT);

    await service.handleSendPost(rt, {
      text: "",
      accountId: ACCOUNT,
      attachments: [{ id: "img", url: "https://cdn.example.com/cat.png", contentType: "image" }],
    } as Content);

    expect(testClient.sendCast).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: ["https://cdn.example.com/cat.png"] })
    );
    // Media-only post must NOT auto-generate prose.
    expect(rt.useModel).not.toHaveBeenCalled();
  });

  it("still rejects a blank post with neither text nor attachments", async () => {
    const testClient = client();
    const rt = runtime({ FARCASTER_FID: "1" });
    const service = new FarcasterCastService(testClient as never, rt, ACCOUNT);

    await expect(
      service.handleSendPost(rt, { text: "   ", accountId: ACCOUNT } as Content)
    ).rejects.toThrow("requires non-empty text");
    expect(testClient.sendCast).not.toHaveBeenCalled();
  });
});

describe("extractCastEmbedUrls (#8990)", () => {
  it("collects non-empty attachment urls and skips blank/missing", () => {
    const urls = extractCastEmbedUrls({
      text: "hi",
      attachments: [
        { id: "1", url: "https://cdn.example.com/a.png" },
        { id: "2", url: "" },
        { id: "3" },
        { id: "4", url: "https://cdn.example.com/b.mp4" },
      ],
    } as unknown as Content);
    expect(urls).toEqual(["https://cdn.example.com/a.png", "https://cdn.example.com/b.mp4"]);
  });

  it("returns [] when there are no attachments", () => {
    expect(extractCastEmbedUrls({ text: "hi" } as Content)).toEqual([]);
  });
});

describe("Farcaster mention-reply attaches media (#8990)", () => {
  const roomId = "00000000-0000-0000-0000-0000000000bb" as const;

  it("passes attachment urls as embeds when replying to a mention", async () => {
    const testClient = client();
    const rt = runtime({ FARCASTER_FID: "1" });
    const callback = standardCastHandlerCallback({
      client: testClient as never,
      runtime: rt,
      config: { FARCASTER_DRY_RUN: false, accountId: ACCOUNT } as never,
      roomId: roomId as never,
      inReplyTo: { hash: "0xparent", fid: 2 } as never,
    });

    await callback({
      text: "here you go",
      attachments: [{ id: "img", url: "https://cdn.example.com/cat.png", contentType: "image" }],
    } as Content);

    expect(testClient.sendCast).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: ["https://cdn.example.com/cat.png"] })
    );
  });

  it("replies text-only with empty embeds when there are no attachments (no regression)", async () => {
    const testClient = client();
    const rt = runtime({ FARCASTER_FID: "1" });
    const callback = standardCastHandlerCallback({
      client: testClient as never,
      runtime: rt,
      config: { FARCASTER_DRY_RUN: false } as never,
      roomId: roomId as never,
    });

    await callback({ text: "just text" } as Content);

    const arg = testClient.sendCast.mock.calls[0][0] as { embeds?: string[] };
    expect(arg.embeds).toEqual([]);
  });
});
