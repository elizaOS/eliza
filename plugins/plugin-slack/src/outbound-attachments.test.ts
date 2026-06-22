import { Buffer } from "node:buffer";
import type { Media } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { SlackService } from "./service";

// Outbound media coverage for the Slack connector (#8876). Slack's API takes
// file BYTES (not a URL), so agent `Media` attachments are fetched through the
// SSRF-guarded fetcher and uploaded via uploadFile. We stub the (instance)
// fetch wrapper + uploadFile so the test runs offline and exercises only the
// new send-outbound-attachments logic.

type TestService = SlackService & {
  sendOutboundAttachments: (
    channelId: string,
    attachments: Media[],
    threadTs: string | undefined,
    accountId: string | null,
  ) => Promise<void>;
  fetchAttachmentBytes: ReturnType<typeof vi.fn>;
  uploadFile: ReturnType<typeof vi.fn>;
};

function createService(): TestService {
  const runtime = {
    agentId: "agent-1",
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  };
  const service = Object.create(SlackService.prototype) as TestService;
  Object.assign(service, { runtime });
  service.fetchAttachmentBytes = vi.fn(async () => ({
    buffer: Buffer.from("bytes"),
    fileName: "fetched.png",
    contentType: "image/png",
  }));
  service.uploadFile = vi.fn(async () => ({ fileId: "F1", permalink: "p" }));
  return service;
}

function media(over: Partial<Media>): Media {
  return { id: "m", url: "https://cdn.example.com/cat.png", ...over } as Media;
}

describe("Slack outbound attachments", () => {
  it("fetches each attachment's bytes and uploads it to the channel", async () => {
    const service = createService();
    await service.sendOutboundAttachments(
      "C123",
      [media({ id: "img", contentType: "image", title: "cat.png" })],
      "111.222",
      "default",
    );

    expect(service.fetchAttachmentBytes).toHaveBeenCalledWith(
      "https://cdn.example.com/cat.png",
    );
    expect(service.uploadFile).toHaveBeenCalledTimes(1);
    expect(service.uploadFile).toHaveBeenCalledWith(
      "C123",
      expect.any(Buffer),
      "cat.png",
      { title: "cat.png", threadTs: "111.222" },
      "default",
    );
  });

  it("uploads multiple attachments", async () => {
    const service = createService();
    await service.sendOutboundAttachments(
      "C1",
      [
        media({ id: "a", url: "https://x/a.png" }),
        media({ id: "b", url: "https://x/b.pdf" }),
      ],
      undefined,
      null,
    );
    expect(service.uploadFile).toHaveBeenCalledTimes(2);
  });

  it("derives the filename: filename > title > fetched name", async () => {
    const service = createService();
    await service.sendOutboundAttachments(
      "C1",
      [media({ id: "x", url: "https://x/blob", filename: "explicit.glb" })],
      undefined,
      null,
    );
    expect(service.uploadFile).toHaveBeenCalledWith(
      "C1",
      expect.any(Buffer),
      "explicit.glb",
      expect.anything(),
      null,
    );

    const service2 = createService();
    await service2.sendOutboundAttachments(
      "C1",
      [media({ id: "y", url: "https://x/blob" })], // no filename/title
      undefined,
      null,
    );
    // Falls back to the name returned by the fetcher.
    expect(service2.uploadFile).toHaveBeenCalledWith(
      "C1",
      expect.any(Buffer),
      "fetched.png",
      expect.anything(),
      null,
    );
  });

  it("swallows a fetch failure (warns) and still uploads the rest", async () => {
    const service = createService();
    service.fetchAttachmentBytes = vi
      .fn()
      .mockRejectedValueOnce(new Error("ssrf blocked"))
      .mockResolvedValueOnce({ buffer: Buffer.from("ok"), fileName: "ok.png" });

    await expect(
      service.sendOutboundAttachments(
        "C1",
        [
          media({ id: "bad", url: "http://169.254.169.254/x" }),
          media({ id: "good", url: "https://x/ok.png" }),
        ],
        undefined,
        null,
      ),
    ).resolves.toBeUndefined();

    expect(service.uploadFile).toHaveBeenCalledTimes(1);
    expect(
      (
        service as unknown as {
          runtime: { logger: { warn: ReturnType<typeof vi.fn> } };
        }
      ).runtime.logger.warn,
    ).toHaveBeenCalled();
  });
});
