/**
 * Deterministic outbound Slack attachment tests covering byte uploads, data-URL
 * resolution, filename precedence, per-file failure isolation, and safe logs.
 * Slack Web API calls are mocked; the data-URL case uses the real core resolver.
 */
import { Buffer } from "node:buffer";
import type { IAgentRuntime, Media } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { SlackService } from "./service";

type TestService = SlackService & {
  sendOutboundAttachments: (
    channelId: string,
    attachments: Media[],
    threadTs: string | undefined,
    accountId: string | null,
  ) => Promise<{ delivered: unknown[]; failures: unknown[] }>;
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

  it("decodes a generated data URL and uploads its bytes", async () => {
    const service = createService();
    const realFetcher = (SlackService.prototype as unknown as TestService)
      .fetchAttachmentBytes;
    service.fetchAttachmentBytes = realFetcher.bind(service) as ReturnType<
      typeof vi.fn
    >;

    await service.sendOutboundAttachments(
      "C1",
      [
        media({
          id: "generated",
          url: "data:image/png;base64,aGVsbG8=",
          title: "generated.png",
        }),
      ],
      undefined,
      null,
    );

    expect(service.uploadFile).toHaveBeenCalledWith(
      "C1",
      Buffer.from("hello"),
      "generated.png",
      { title: "generated.png", threadTs: undefined },
      null,
    );
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

  it("reports a fetch failure and still uploads the rest", async () => {
    const service = createService();
    service.fetchAttachmentBytes = vi
      .fn()
      .mockRejectedValueOnce(new Error("ssrf blocked"))
      .mockResolvedValueOnce({ buffer: Buffer.from("ok"), fileName: "ok.png" });

    const delivery = await service.sendOutboundAttachments(
      "C1",
      [
        media({ id: "bad", url: "DATA:image/png;base64,c2VjcmV0" }),
        media({ id: "good", url: "https://x/ok.png" }),
      ],
      undefined,
      null,
    );
    expect(delivery).toMatchObject({
      delivered: [{ fileId: "F1" }],
      failures: [
        {
          source: { scheme: "data", path: "image/png" },
          code: "SLACK_ATTACHMENT_UPLOAD_FAILED",
        },
      ],
    });
    expect(JSON.stringify(delivery)).not.toContain("c2VjcmV0");

    expect(service.uploadFile).toHaveBeenCalledTimes(1);
    const warn = (
      service as unknown as {
        runtime: { logger: { warn: ReturnType<typeof vi.fn> } };
      }
    ).runtime.logger.warn;
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      scheme: "data",
      path: "image/png",
    });
    expect(warn.mock.calls[0]?.[0]).not.toHaveProperty("url");
    expect(JSON.stringify(warn.mock.calls[0]?.[0])).not.toContain("c2VjcmV0");
  });
});

it("returns partial receipts instead of success when an attachment cannot be fetched", async () => {
  const service = createService();
  Object.assign(service, {
    resolveAccountIdForTarget: async () => null,
    getClientForAccount: () => ({}),
    sendMessage: vi.fn(async () => ({
      messages: [{ ts: "1234567890.123456" }],
    })),
  });
  service.fetchAttachmentBytes.mockRejectedValueOnce(new Error("fetch denied"));
  const outcome = await service.handleSendMessage(
    {} as IAgentRuntime,
    { source: "slack", channelId: "C12345678" },
    {
      text: "caption",
      attachments: [media({ url: "https://bad.example/file" })],
    },
  );
  expect(outcome).toMatchObject({
    kind: "partially_delivered",
    receipt: { providerMessageIds: ["1234567890.123456"] },
  });
});

it("rejects a missing attachment URL before sending text", async () => {
  const service = createService();
  const send = vi.fn();
  Object.assign(service, {
    resolveAccountIdForTarget: async () => null,
    getClientForAccount: () => ({}),
    sendMessage: send,
  });
  expect(
    await service.handleSendMessage(
      {} as IAgentRuntime,
      { source: "slack", channelId: "C12345678" },
      { text: "caption", attachments: [media({ url: "" })] },
    ),
  ).toMatchObject({ kind: "not_delivered", code: "SLACK_INVALID_ATTACHMENT" });
  expect(send).not.toHaveBeenCalled();
});

it("does not turn an uncertain upload into retry-safe non-delivery", async () => {
  const service = createService();
  Object.assign(service, {
    resolveAccountIdForTarget: async () => null,
    getClientForAccount: () => ({}),
  });
  service.uploadFile.mockRejectedValueOnce(
    new Error("response lost after upload"),
  );
  await expect(
    service.handleSendMessage(
      {} as IAgentRuntime,
      { source: "slack", channelId: "C12345678" },
      { attachments: [media({})] },
    ),
  ).rejects.toMatchObject({ code: "SLACK_DELIVERY_UNKNOWN" });
});
