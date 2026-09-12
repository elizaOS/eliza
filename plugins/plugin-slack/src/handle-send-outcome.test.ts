import { Buffer } from "node:buffer";
import {
  type Content,
  isSendHandlerOutcome,
  type Media,
  type TargetInfo,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { SlackService } from "./service";

// Composed delivery-truth coverage for the Slack send handler (#23104):
// handleSendMessage must derive one structural SendHandlerOutcome from the
// text chunk receipts plus per-part attachment evidence, so a text-only
// receipt can never mask requested-but-failed attachments. Runs offline by
// stubbing the instance seams the production path calls: account resolution,
// client lookup, channel resolution, text sendMessage, fetch, and upload.

type SendOutcome = Awaited<ReturnType<SlackService["handleSendMessage"]>>;

type TestService = SlackService & {
  resolveAccountIdForTarget: ReturnType<typeof vi.fn>;
  getClientForAccount: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  fetchAttachmentBytes: ReturnType<typeof vi.fn>;
  uploadFile: ReturnType<typeof vi.fn>;
};

function createService(overrides?: {
  textReceipts?: Array<{ ts: string; text: string }>;
}): TestService {
  const runtime = {
    agentId: "agent-1",
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  };
  const service = Object.create(SlackService.prototype) as TestService;
  Object.assign(service, { runtime });
  service.resolveAccountIdForTarget = vi.fn(async () => "default");
  service.getClientForAccount = vi.fn(() => ({ client: true }));
  service.sendMessage = vi.fn(async () => ({
    ts: overrides?.textReceipts?.at(-1)?.ts ?? "1234.0001",
    channelId: "C1",
    messages: overrides?.textReceipts ?? [{ ts: "1234.0001", text: "hello" }],
  }));
  service.fetchAttachmentBytes = vi.fn(async () => ({
    buffer: Buffer.from("bytes"),
    fileName: "fetched.png",
    contentType: "image/png",
  }));
  service.uploadFile = vi.fn(async () => ({ fileId: "F1", permalink: "p" }));
  return service;
}

const runtimeStub = {
  agentId: "agent-1",
  getRoom: vi.fn(async () => undefined),
} as unknown as Parameters<SlackService["handleSendMessage"]>[0];

const target: TargetInfo = { source: "slack", channelId: "C1" };

function withAttachments(urls: string[]): Content {
  const attachments: Media[] = urls.map(
    (url, index) => ({ id: `m${index}`, url }) as Media,
  );
  return { text: "here are the files", attachments };
}

describe("Slack handleSendMessage delivery outcomes", () => {
  it("returns delivered with ordered ts+fileId provider ids when all parts succeed", async () => {
    const service = createService({
      textReceipts: [
        { ts: "111.000100", text: "part one " },
        { ts: "111.0002", text: "part two" },
      ],
    });
    const outcome: SendOutcome = await service.handleSendMessage(
      runtimeStub,
      target,
      withAttachments(["https://x/a.png", "https://x/b.png"]),
    );

    expect(outcome.kind).toBe("delivered");
    expect(isSendHandlerOutcome(outcome)).toBe(true);
    if (outcome.kind !== "delivered") return;
    // Text chunk ts values in send order, then accepted file ids in request order.
    expect(outcome.receipt.providerMessageIds).toEqual([
      "111.000100",
      "111.0002",
      "F1",
      "F1",
    ]);
    expect(outcome.receipt.persistence.status).toBe("not_attempted");
    expect(outcome.memories).toEqual([]);
  });

  it("returns partially_delivered when text succeeds but every attachment fails", async () => {
    const service = createService();
    service.fetchAttachmentBytes = vi
      .fn()
      .mockRejectedValue(new Error("ssrf blocked"));

    const outcome = await service.handleSendMessage(
      runtimeStub,
      target,
      withAttachments(["http://169.254.169.254/x"]),
    );

    expect(outcome.kind).toBe("partially_delivered");
    expect(isSendHandlerOutcome(outcome)).toBe(true);
    if (outcome.kind !== "partially_delivered") return;
    // The text ts is real provider evidence of the partial delivery.
    expect(outcome.receipt.providerMessageIds).toEqual(["1234.0001"]);
    expect(outcome.code).toBe("SLACK_ATTACHMENT_PARTIAL_DELIVERY");
    expect(outcome.message).toContain("169.254.169.254");
    expect(outcome.message).toContain("SLACK_ATTACHMENT_UPLOAD_FAILED");
  });

  it("returns partially_delivered enumerating the failed subset when some attachments fail", async () => {
    const service = createService();
    service.fetchAttachmentBytes = vi
      .fn()
      .mockResolvedValueOnce({ buffer: Buffer.from("ok"), fileName: "ok.png" })
      .mockRejectedValueOnce(new Error("unreachable host"))
      .mockResolvedValueOnce({
        buffer: Buffer.from("ok2"),
        fileName: "ok2.png",
      });

    const outcome = await service.handleSendMessage(
      runtimeStub,
      target,
      withAttachments([
        "https://x/1.png",
        "https://x/2.png",
        "https://x/3.png",
      ]),
    );

    expect(outcome.kind).toBe("partially_delivered");
    expect(isSendHandlerOutcome(outcome)).toBe(true);
    if (outcome.kind !== "partially_delivered") return;
    // Text ts + the two accepted file ids; the failed part is excluded.
    expect(outcome.receipt.providerMessageIds).toEqual([
      "1234.0001",
      "F1",
      "F1",
    ]);
    expect(outcome.message).toContain("https://x/2.png");
    expect(outcome.message).toContain("unreachable host");
  });

  it("returns not_delivered when attachments-only all fail (nothing accepted)", async () => {
    const service = createService();
    service.fetchAttachmentBytes = vi
      .fn()
      .mockRejectedValue(new Error("oversized"));

    const outcome = await service.handleSendMessage(runtimeStub, target, {
      text: "",
      attachments: [
        { id: "m0", url: "https://x/huge.bin" } as Media,
        { id: "m1", url: "https://x/huge2.bin" } as Media,
      ],
    });

    expect(outcome.kind).toBe("not_delivered");
    expect(isSendHandlerOutcome(outcome)).toBe(true);
    if (outcome.kind !== "not_delivered") return;
    expect(outcome.code).toBe("SLACK_ATTACHMENT_DELIVERY_FAILED");
    expect(outcome.message).toContain("oversized");
  });

  it("returns delivered with a file-id-only receipt for attachments-only sends", async () => {
    const service = createService();
    const outcome = await service.handleSendMessage(runtimeStub, target, {
      text: "",
      attachments: [{ id: "m0", url: "https://x/only.png" } as Media],
    });

    expect(outcome.kind).toBe("delivered");
    expect(isSendHandlerOutcome(outcome)).toBe(true);
    if (outcome.kind !== "delivered") return;
    expect(outcome.receipt.providerMessageIds).toEqual(["F1"]);
    expect(service.sendMessage).not.toHaveBeenCalled();
  });

  it("treats an upload resolving without a file id as a failed part, never fabricated success", async () => {
    const service = createService();
    service.uploadFile = vi.fn(async () => ({ fileId: "", permalink: "" }));

    const outcome = await service.handleSendMessage(
      runtimeStub,
      target,
      withAttachments(["https://x/ghost.png"]),
    );

    expect(outcome.kind).toBe("partially_delivered");
    expect(isSendHandlerOutcome(outcome)).toBe(true);
    if (outcome.kind !== "partially_delivered") return;
    // No "" id may appear as provider evidence.
    expect(outcome.receipt.providerMessageIds).toEqual(["1234.0001"]);
    expect(outcome.message).toContain("SLACK_FILE_ID_MISSING");
  });

  it("attempts and reports a whitespace-only attachment URL as a failed part, never silently skipping it", async () => {
    const service = createService();
    // A real fetch rejects an unparseable whitespace URL; mirror that here.
    service.fetchAttachmentBytes = vi.fn(async (url: string) => {
      if (!url.trim()) throw new Error("Invalid URL");
      return { buffer: Buffer.from("bytes"), fileName: "fetched.png" };
    });
    const outcome = await service.handleSendMessage(runtimeStub, target, {
      text: "see attached",
      attachments: [{ id: "m0", url: "   " } as Media],
    });

    expect(outcome.kind).toBe("partially_delivered");
    expect(isSendHandlerOutcome(outcome)).toBe(true);
    if (outcome.kind !== "partially_delivered") return;
    expect(service.fetchAttachmentBytes).toHaveBeenCalledWith("   ");
    expect(outcome.receipt.providerMessageIds).toEqual(["1234.0001"]);
    expect(outcome.message).toContain("   ");
  });

  it("returns not_delivered with a stable code for empty content instead of throwing", async () => {
    const service = createService();
    const outcome = await service.handleSendMessage(runtimeStub, target, {
      text: "   ",
      attachments: [],
    });

    expect(outcome.kind).toBe("not_delivered");
    expect(isSendHandlerOutcome(outcome)).toBe(true);
    if (outcome.kind !== "not_delivered") return;
    expect(outcome.code).toBe("SLACK_EMPTY_MESSAGE");
  });

  // Real sendMessage path (only the Slack client is stubbed): a later text
  // chunk failing must surface the already-accepted chunk ts evidence as a
  // partial delivery instead of throwing it away (#23104 review blocker 1).
  // Structural view of the seams the real path calls; avoids intersecting
  // the class type (private members collapse such intersections to never).
  type RealPathService = {
    runtime: {
      agentId: string;
      logger: Record<string, ReturnType<typeof vi.fn>>;
    };
    resolveAccountIdForTarget: (
      runtime: unknown,
      target: unknown,
    ) => Promise<string>;
    getAccountState: (accountId?: string | null) => null;
    getClientForAccount: (accountId?: string | null) => {
      chat: { postMessage: ReturnType<typeof vi.fn> };
    };
    handleSendMessage: SlackService["handleSendMessage"];
  };

  function createRealPathService(postMessage: ReturnType<typeof vi.fn>) {
    const runtime = {
      agentId: "agent-1",
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    };
    const service = Object.create(
      SlackService.prototype,
    ) as unknown as RealPathService;
    service.runtime = runtime;
    service.resolveAccountIdForTarget = async () => "default";
    // getOutboundClient falls back to getClientForAccount when no account
    // state exists, so the real sendMessage loop uses the stubbed client.
    service.getAccountState = () => null;
    service.getClientForAccount = () => ({ chat: { postMessage } });
    return service;
  }

  // MAX_SLACK_MESSAGE_LENGTH is 40_000 on develop (#28854); 40_001 chars
  // still exercise the two-chunk partial-delivery path.
  const TWO_CHUNK_TEXT = "a".repeat(40_001);

  it("returns partially_delivered with accepted chunk ts evidence when a later chunk rejects", async () => {
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ts: "111.000100" })
      .mockRejectedValueOnce(new Error("slack api down"));
    const service = createRealPathService(postMessage);

    const outcome: SendOutcome = await service.handleSendMessage(
      runtimeStub,
      target,
      { text: TWO_CHUNK_TEXT },
    );

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(outcome.kind).toBe("partially_delivered");
    expect(isSendHandlerOutcome(outcome)).toBe(true);
    if (outcome.kind !== "partially_delivered") return;
    // Chunk 1 was accepted by Slack: its ts is real provider evidence and
    // must reach the receipt so an outer retry cannot duplicate it blindly.
    expect(outcome.receipt.providerMessageIds).toEqual(["111.000100"]);
    expect(outcome.code).toBe("SLACK_TEXT_PARTIAL_DELIVERY");
    expect(outcome.message).toContain("slack api down");
  });

  it("returns partially_delivered when a later chunk resolves without a valid ts", async () => {
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ts: "111.000100" })
      .mockResolvedValueOnce({ ts: "not-a-ts" });
    const service = createRealPathService(postMessage);

    const outcome: SendOutcome = await service.handleSendMessage(
      runtimeStub,
      target,
      { text: TWO_CHUNK_TEXT },
    );

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(outcome.kind).toBe("partially_delivered");
    if (outcome.kind !== "partially_delivered") return;
    expect(outcome.receipt.providerMessageIds).toEqual(["111.000100"]);
    expect(outcome.message).toContain("SLACK_POST_MESSAGE_IDENTITY_MISSING");
  });

  it("still throws the underlying error when the FIRST chunk fails (nothing accepted)", async () => {
    const postMessage = vi.fn().mockRejectedValue(new Error("no auth"));
    const service = createRealPathService(postMessage);

    await expect(
      service.handleSendMessage(runtimeStub, target, { text: TWO_CHUNK_TEXT }),
    ).rejects.toThrow("no auth");
  });
});
